#!/usr/bin/env node
/**
 * Build script for mayara-server-signalk-plugin
 *
 * Copies GUI files from mayara-server/web/gui/ to public/
 *
 * Usage: node build.js [--gui-path <path>] [--pack]
 *   --gui-path   Path to mayara-server/web/gui/ (default: auto-detect)
 *   --pack       Create a .tgz tarball with public/ included
 */

const fs = require('fs')
const path = require('path')
const { execSync } = require('child_process')

const args = process.argv.slice(2)
const createPack = args.includes('--pack')

const guiPathIdx = args.indexOf('--gui-path')
function findGuiSource() {
  if (guiPathIdx !== -1) {
    const val = args[guiPathIdx + 1]
    if (!val || val.startsWith('--')) {
      console.error('Error: --gui-path requires a path argument')
      process.exit(1)
    }
    return path.resolve(val)
  }
  const candidates = [
    path.resolve(__dirname, '..', 'mayara-server', 'web', 'gui'),
    path.resolve(__dirname, 'mayara-server', 'web', 'gui')
  ]
  for (const c of candidates) {
    if (fs.existsSync(c)) return c
  }
  return candidates[0]
}
const guiSource = findGuiSource()

const publicDest = path.join(__dirname, 'public')

const COPY_EXTENSIONS = ['.html', '.js', '.css', '.ico', '.svg']
const COPY_DIRS = ['assets', 'proto', 'protobuf', 'audio']
const EXCLUDE_FILES = ['recordings.html', 'recordings.js', 'recordings.css']

function copyDir(src, dest) {
  if (!fs.existsSync(src)) {
    console.error(`Source directory not found: ${src}`)
    process.exit(1)
  }
  fs.mkdirSync(dest, { recursive: true })
  const entries = fs.readdirSync(src, { withFileTypes: true })
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name)
    const destPath = path.join(dest, entry.name)
    if (entry.isDirectory()) {
      copyDir(srcPath, destPath)
    } else {
      fs.copyFileSync(srcPath, destPath)
    }
  }
}

function copyGui() {
  if (!fs.existsSync(guiSource)) {
    console.error(`GUI source not found: ${guiSource}`)
    console.error('Use --gui-path to specify the path to mayara-server/web/gui/')
    process.exit(1)
  }

  console.log(`Copying GUI from ${guiSource}...\n`)

  if (fs.existsSync(publicDest)) {
    fs.rmSync(publicDest, { recursive: true })
  }
  fs.mkdirSync(publicDest, { recursive: true })

  const entries = fs.readdirSync(guiSource, { withFileTypes: true })
  for (const entry of entries) {
    if (EXCLUDE_FILES.includes(entry.name)) continue

    const srcPath = path.join(guiSource, entry.name)
    const destPath = path.join(publicDest, entry.name)

    if (entry.isDirectory()) {
      if (COPY_DIRS.includes(entry.name)) {
        copyDir(srcPath, destPath)
      }
    } else if (COPY_EXTENSIONS.some((ext) => entry.name.endsWith(ext))) {
      fs.copyFileSync(srcPath, destPath)
    }
  }

  const fileCount = fs.readdirSync(publicDest, { recursive: true }).length
  console.log(`Copied ${fileCount} GUI files to public/\n`)
}

function main() {
  console.log('=== MaYaRa SignalK Plugin Build ===\n')
  copyGui()

  if (createPack) {
    console.log('Creating tarball with public/ included...\n')
    const npmignorePath = path.join(__dirname, '.npmignore')
    const npmignoreContent = fs.readFileSync(npmignorePath, 'utf8')
    const npmignoreWithoutPublic = npmignoreContent.replace(/^\/public\/\n?/m, '')
    fs.writeFileSync(npmignorePath, npmignoreWithoutPublic)

    const pkgPath = path.join(__dirname, 'package.json')
    const pkgContent = fs.readFileSync(pkgPath, 'utf8')
    const pkg = JSON.parse(pkgContent)
    const originalFiles = [...pkg.files]
    pkg.files.push('public/**/*')
    fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n')

    try {
      execSync('npm pack', { stdio: 'inherit', cwd: __dirname })
      console.log('\nTarball created successfully!')
    } finally {
      fs.writeFileSync(npmignorePath, npmignoreContent)
      pkg.files = originalFiles
      fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n')
    }
  }

  console.log('\n=== Build complete ===')
}

main()
