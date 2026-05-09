import { execFileSync } from 'node:child_process'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const regions = [
	'africa',
	'antarctica',
	'australia-oceania',
	'central-america-n-caribbean',
	'central-asia',
	'east-n-southeast-asia',
	'europe',
	'middle-east',
	'north-america',
	'oceans',
	'south-america',
	'south-asia',
	'world',
]

const repo = 'https://github.com/factbook/factbook.json/archive/refs/heads/master.zip'
const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'factbook-'))
const zipPath = path.join(tmpDir, 'factbook.zip')
const extractPath = path.join(tmpDir, 'extracted')

const entries = []

try {
	await download(repo, zipPath)
	await extract(zipPath, extractPath)

	const baseDir = path.join(extractPath, 'factbook.json-master')

	for (const region of regions) {
		const regionDir = path.join(baseDir, region)

		let files

		try {
			files = await fs.readdir(regionDir)
		} catch {
			console.warn(`Region directory not found: ${region}`)

			continue
		}

		for (const file of files.filter(f => f.endsWith('.json'))) {
			const content = await fs.readFile(path.join(regionDir, file), 'utf-8')
			const data = JSON.parse(content)
			const entry = parseEntry(data)

			if (entry)
				entries.push(entry)
		}
	}

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
} finally {
	await fs.rm(tmpDir, { recursive: true, force: true })
}

function parseEntry(data) {
	const government = data['Government']
	const geodata = data['Geography']
	if (!government || !geodata) return null

	const name =
		government['Country name']?.['conventional short form']?.text ??
		government['Country name']?.['conventional long form']?.text

	if (!name || name === 'none')
		return null

	const isDependency = !!government['Dependency status']?.text
	const isIndependent = !!government['Independence']?.text

	// exclude non-country entities (world, EU, oceans, etc.)
	if (!isDependency && !isIndependent)
		return null

	const landarea = parseArea(geodata['Area']?.['land']?.text)
	// yeah, `total ` is a quirky key... and the fallback is because of Vatican having 0 area but 0.44 land area in the factbook.
	const area = parseArea(geodata['Area']?.['total ']?.text) || landarea
	const highest = parseElevation(geodata['Elevation']?.['highest point']?.text)
	const lowest = parseElevation(geodata['Elevation']?.['lowest point']?.text)
	const meanElevation = parseMeters(geodata['Elevation']?.['mean elevation']?.text)

	return { name, area, landarea, highest, lowest, meanElevation, isDependency }
}

function parseArea(text) {
	if (!text)
		return null

	// "64,589 sq km" -> 64589, "0.44 sq km" -> 0.44, "1.267 million sq km" -> 1267000
	const match = text.match(/^([\d,.]+)(\s*million)?/)
	if (!match)
		return null

	const value = parseFloat(match[1].replaceAll(',', ''))

	return match[2] ? value * 1_000_000 : value
}

function parseElevation(text) {
	if (!text)
		return null

	// "Tomanivi 1,324 m" -> { name: "Tomanivi", elevation: 1324 }
	const match = text.match(/^(.+?)\s+([\d,]+)\s*m/i)
	if (!match)
		return { name: text, elevation: null }

	return {
		name: match[1].trim(),
		elevation: parseInt(match[2].replaceAll(',', ''), 10),
	}
}

function parseMeters(text) {
	if (!text)
		return null

	// "797 m" -> 797
	const match = text.match(/([\d,]+)\s*m/i)
	return match ? parseInt(match[1].replaceAll(',', ''), 10) : null
}

async function download(url, dest) {
	const response = await fetch(url)
	if (!response.ok) throw new Error(`Failed to download ${url}: ${response.status} ${response.statusText}`)
	await fs.writeFile(dest, Buffer.from(await response.arrayBuffer()))
}

async function extract(zipPath, dest) {
	await fs.mkdir(dest, { recursive: true })
	execFileSync('unzip', ['-q', zipPath, '-d', dest])
}
