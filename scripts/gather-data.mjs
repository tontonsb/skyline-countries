import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// P297  ISO 3166-1 alpha-2 code (used to select countries + territories)
// P2046 area (km²)
// P610  highest point
// P1589 lowest point
// P2044 elevation above sea level (m)
// Q3624078 sovereign state
const query = `
SELECT ?entity ?entityLabel ?iso ?area ?hp ?hpLabel ?hpElev ?lp ?lpLabel ?lpElev ?sovereign WHERE {
  ?entity wdt:P297 ?iso .
  OPTIONAL { ?entity wdt:P2046 ?area }
  OPTIONAL {
    ?entity wdt:P610 ?hp .
    OPTIONAL { ?hp wdt:P2044 ?hpElev }
  }
  OPTIONAL {
    ?entity wdt:P1589 ?lp .
    OPTIONAL { ?lp wdt:P2044 ?lpElev }
  }
  BIND(EXISTS { ?entity wdt:P31 wd:Q3624078 } AS ?sovereign)
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en" }
}
ORDER BY ?entityLabel
`

// Wikidata classifies some sovereign states under a different P31 value
// (e.g. Denmark as "constitutional monarchy" rather than "sovereign state")
const SOVEREIGN_ISO_OVERRIDES = new Set(['DK', 'IL'])

// Wikipedia name → Wikidata name mismatches
const WIKI_NAME_MAP = {
	'Gambia': 'The Gambia',
	'Ivory Coast': "Côte d'Ivoire",
	'Netherlands': 'Kingdom of the Netherlands',
	'United States': 'United States of America',
}

function parseElev(text) {
	if (/sea\s+level/i.test(text)) return 0
	const match = text.replace(/,/g, '').match(/-?\d+/)
	return match ? parseInt(match[0], 10) : null
}

async function fetchWikipediaElevations() {
	const url = 'https://en.wikipedia.org/w/api.php?' + new URLSearchParams({
		action: 'parse',
		page: 'List_of_elevation_extremes_by_country',
		prop: 'text',
		format: 'json',
	})
	const res = await fetch(url, {
		headers: {
			Accept: 'application/json',
			'User-Agent': 'skyline-countries/1.0 (https://github.com/tontonsb/skyline-countries)',
		},
	})
	if (!res.ok)
		throw new Error(`Wikipedia fetch failed: ${res.status} ${res.statusText}`)
	const { parse: { text: { '*': html } } } = await res.json()

	const clean = s => s
		.replace(/<[^>]+>/g, '')
		.replace(/&#91;[^&#]*&#93;/g, '')
		.replace(/\[[^\]]*\]/g, '')
		.replace(/&#160;/g, ' ')
		.replace(/−/g, '-')
		.replace(/\s+/g, ' ')
		.trim()

	const map = new Map()
	for (const [, rowHtml] of html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
		const cells = [...rowHtml.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)]
		if (cells.length < 5) continue
		const texts = cells.map(([, inner]) => clean(inner))
		const wikiName = texts[0]
		const name = WIKI_NAME_MAP[wikiName] ?? wikiName
		if (name) map.set(name, {
			hpName: texts[1], hpElev: parseElev(texts[2]),
			lpName: texts[3], lpElev: parseElev(texts[4]),
		})
	}
	return map
}

const url = 'https://query.wikidata.org/sparql?format=json&query=' + encodeURIComponent(query)

console.log('Querying Wikidata and Wikipedia...')

const [response, wikiElevs] = await Promise.all([
	fetch(url, {
		headers: {
			Accept: 'application/sparql-results+json',
			'User-Agent': 'skyline-countries/1.0 (https://github.com/tontonsb/skyline-countries)',
		},
	}),
	fetchWikipediaElevations(),
])

if (!response.ok)
	throw new Error(`SPARQL query failed: ${response.status} ${response.statusText}`)

const { results: { bindings } } = await response.json()

// Multiple rows per entity when optional fields have multiple values — merge them
const entityMap = new Map()

for (const row of bindings) {
	const id = row.entity.value

	if (!entityMap.has(id)) {
		entityMap.set(id, {
			iso: row.iso?.value ?? null,
			name: row.entityLabel?.value ?? null,
			area: null,
			highest: null,
			lowest: null,
			isDependency: row.sovereign.value !== 'true',
		})
	}

	const entry = entityMap.get(id)

	if (entry.area === null && row.area)
		entry.area = parseFloat(row.area.value)

	if (entry.highest === null && row.hp)
		entry.highest = {
			name: row.hpLabel?.value ?? null,
			elevation: row.hpElev ? Math.round(parseFloat(row.hpElev.value)) : null,
		}

	if (entry.lowest === null && row.lp) {
		const elev = row.lpElev ? Math.round(parseFloat(row.lpElev.value)) : null
		// discard submarine features — deepest exposed land is ~-430m (Dead Sea)
		if (elev === null || elev >= -500)
			entry.lowest = { name: row.lpLabel?.value ?? null, elevation: elev }
	}
}

for (const entry of entityMap.values()) {
	if (entry.iso && SOVEREIGN_ISO_OVERRIDES.has(entry.iso))
		entry.isDependency = false
}

const entries = [...entityMap.values()]
	.filter(e => e.name && !/^Q\d+$/.test(e.name))  // drop entries with no English label
	.sort((a, b) => a.name.localeCompare(b.name))

for (const entry of entries) {
	const wiki = wikiElevs.get(entry.name)
	if (!wiki) continue

	if (entry.highest === null && wiki.hpElev !== null)
		entry.highest = { name: wiki.hpName || null, elevation: wiki.hpElev }
	else if (entry.highest?.elevation === null && wiki.hpElev !== null)
		entry.highest.elevation = wiki.hpElev

	// entry.lowest is null when Wikidata had no data or a submarine feature (< -500m)
	if (entry.lowest === null && wiki.lpElev !== null)
		entry.lowest = { name: wiki.lpName || null, elevation: wiki.lpElev }
	else if (entry.lowest?.elevation === null && wiki.lpElev !== null)
		entry.lowest.elevation = wiki.lpElev
}

const patchesPath = path.join(__dirname, 'patches.json')
let patches = {}
try {
	patches = JSON.parse(await fs.readFile(patchesPath, 'utf8'))
} catch (e) {
	if (e.code !== 'ENOENT') throw e
}
for (const entry of entries) {
	const patch = patches[entry.name]
	if (patch) Object.assign(entry, patch)
}

const write = (filename, data) => {
	const outputPath = path.join(__dirname, '../assets', filename)
	return fs.writeFile(outputPath, JSON.stringify(data, null, '\t'))
}

const countries = entries.filter(e => !e.isDependency).map(({ isDependency, iso, ...rest }) => rest)
const countriesAndDeps = entries.map(({ isDependency, iso, ...rest }) => rest)

await Promise.all([
	write('countries.json', countries),
	write('countries-and-dependencies.json', countriesAndDeps),
])

console.log(`Written ${countries.length} countries, ${entries.length} total entries`)
