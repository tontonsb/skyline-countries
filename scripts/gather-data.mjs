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
SELECT ?entity ?entityLabel ?area ?hp ?hpLabel ?hpElev ?lp ?lpLabel ?lpElev ?sovereign WHERE {
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

const url = 'https://query.wikidata.org/sparql?format=json&query=' + encodeURIComponent(query)

console.log('Querying Wikidata...')

const response = await fetch(url, {
	headers: {
		Accept: 'application/sparql-results+json',
		'User-Agent': 'skyline-countries/1.0 (https://github.com/tontonsb/skyline-countries)',
	},
})

if (!response.ok)
	throw new Error(`SPARQL query failed: ${response.status} ${response.statusText}`)

const { results: { bindings } } = await response.json()

// Multiple rows per entity when optional fields have multiple values — merge them
const entityMap = new Map()

for (const row of bindings) {
	const id = row.entity.value

	if (!entityMap.has(id)) {
		entityMap.set(id, {
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

	if (entry.lowest === null && row.lp)
		entry.lowest = {
			name: row.lpLabel?.value ?? null,
			elevation: row.lpElev ? Math.round(parseFloat(row.lpElev.value)) : null,
		}
}

const entries = [...entityMap.values()]
	.filter(e => e.name && !/^Q\d+$/.test(e.name))  // drop entries with no English label
	.sort((a, b) => a.name.localeCompare(b.name))

const write = (filename, data) => {
	const outputPath = path.join(__dirname, '../assets', filename)
	return fs.writeFile(outputPath, JSON.stringify(data, null, '\t'))
}

const countries = entries.filter(e => !e.isDependency).map(({ isDependency, ...rest }) => rest)
const countriesAndDeps = entries.map(({ isDependency, ...rest }) => rest)

await Promise.all([
	write('countries.json', countries),
	write('countries-and-dependencies.json', countriesAndDeps),
])

console.log(`Written ${countries.length} countries, ${entries.length} total entries`)
