#!/usr/bin/env node
/**
 * Build script for mayara-server-signalk-plugin
 *
 * Downloads @marineyachtradar/mayara-gui from npm and copies GUI files to public/
 *
 * Usage: node build.js [--local-gui]
 *   --local-gui  Use local mayara-gui instead of npm (for development)
 */

const fs = require('fs')
const path = require('path')

const args = process.argv.slice(2)
const useLocalGui = args.includes('--local-gui')

// Paths (relative to this script's directory)
const scriptDir = __dirname
const publicDest = path.join(scriptDir, 'public')

/**
 * Recursively copy directory contents
 */
function copyDir(src, dest) {
  if (!fs.existsSync(src)) {
    console.error(`Source directory not found: ${src}`)
    process.exit(1)
  }

  // Remove destination if it exists
  if (fs.existsSync(dest)) {
    fs.rmSync(dest, { recursive: true })
  }

  // Create destination directory
  fs.mkdirSync(dest, { recursive: true })

  // Copy all files and subdirectories
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

/**
 * Download GUI from npm and copy to public/
 */
function setupGuiFromNpm() {
  console.log('Copying GUI from node_modules...\n')

  // Dependencies should already be installed by npm install
  // (this script runs as postinstall, so node_modules exists)
  const guiSource = path.join(scriptDir, 'node_modules', '@marineyachtradar', 'mayara-gui')

  if (!fs.existsSync(guiSource)) {
    console.error('Error: @marineyachtradar/mayara-gui not found in node_modules')
    console.error('Make sure it is listed in package.json dependencies')
    process.exit(1)
  }

  // Remove old public dir
  if (fs.existsSync(publicDest)) {
    fs.rmSync(publicDest, { recursive: true })
  }
  fs.mkdirSync(publicDest, { recursive: true })

  // Copy GUI files (exclude package.json, node_modules, etc.)
  const guiPatterns = [
    { ext: '.html' },
    { ext: '.js' },
    { ext: '.css' },
    { ext: '.ico' },
    { ext: '.svg' },
    { dir: 'assets' },
    { dir: 'proto' },
    { dir: 'protobuf' }
  ]

  const entries = fs.readdirSync(guiSource, { withFileTypes: true })
  for (const entry of entries) {
    const srcPath = path.join(guiSource, entry.name)
    const destPath = path.join(publicDest, entry.name)

    if (entry.isDirectory()) {
      // Copy known directories
      if (guiPatterns.some(p => p.dir === entry.name)) {
        copyDir(srcPath, destPath)
      }
    } else {
      // Copy files matching extensions
      if (guiPatterns.some(p => p.ext && entry.name.endsWith(p.ext))) {
        fs.copyFileSync(srcPath, destPath)
      }
    }
  }

  const fileCount = fs.readdirSync(publicDest, { recursive: true }).length
  console.log(`Copied ${fileCount} GUI files to public/\n`)
}

/**
 * Copy GUI from local sibling directory (for development)
 */
function setupGuiFromLocal() {
  const localGuiPath = path.join(scriptDir, '..', 'mayara-gui')
  console.log(`Copying GUI from local ${localGuiPath}...\n`)

  // Remove old public dir
  if (fs.existsSync(publicDest)) {
    fs.rmSync(publicDest, { recursive: true })
  }
  fs.mkdirSync(publicDest, { recursive: true })

  // Copy GUI files (exclude package.json, node_modules, .git, etc.)
  const guiPatterns = [
    { ext: '.html' },
    { ext: '.js' },
    { ext: '.css' },
    { ext: '.ico' },
    { ext: '.svg' },
    { dir: 'assets' },
    { dir: 'proto' },
    { dir: 'protobuf' }
  ]

  const entries = fs.readdirSync(localGuiPath, { withFileTypes: true })
  for (const entry of entries) {
    const srcPath = path.join(localGuiPath, entry.name)
    const destPath = path.join(publicDest, entry.name)

    if (entry.isDirectory()) {
      // Copy known directories
      if (guiPatterns.some(p => p.dir === entry.name)) {
        copyDir(srcPath, destPath)
      }
    } else {
      // Copy files matching extensions
      if (guiPatterns.some(p => p.ext && entry.name.endsWith(p.ext))) {
        fs.copyFileSync(srcPath, destPath)
      }
    }
  }

  const fileCount = fs.readdirSync(publicDest, { recursive: true }).length
  console.log(`Copied ${fileCount} files from local mayara-gui/ to public/\n`)
}

function main() {
  console.log('=== MaYaRa SignalK Plugin Build ===\n')

  // Check if public/ already exists with content (pre-built tarball)
  const indexHtml = path.join(publicDest, 'index.html')
  if (fs.existsSync(indexHtml) && !useLocalGui) {
    console.log('GUI assets already present in public/, skipping build.\n')
    console.log('=== Build complete ===')
    return
  }

  // Get GUI assets
  console.log('Setting up GUI assets...\n')
  if (useLocalGui) {
    setupGuiFromLocal()
  } else {
    setupGuiFromNpm()
  }

  console.log('=== Build complete ===')
}

main()
