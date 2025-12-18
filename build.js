#!/usr/bin/env node
/**
 * Build script for mayara-server-signalk-plugin
 *
 * Downloads @marineyachtradar/mayara-gui from npm and copies GUI files to public/
 *
 * Usage: node build.js [--local-gui]
 *   --local-gui  Use local mayara-gui instead of npm (for development)
 */

const { execSync } = require('child_process')
const fs = require('fs')
const path = require('path')

const args = process.argv.slice(2)
const useLocalGui = args.includes('--local-gui')

// Paths (relative to this script's directory)
const scriptDir = __dirname
const publicDest = path.join(scriptDir, 'public')

function run(cmd, options = {}) {
  console.log(`> ${cmd}`)
  try {
    execSync(cmd, { stdio: 'inherit', cwd: options.cwd || scriptDir, ...options })
  } catch (e) {
    console.error(`Command failed: ${cmd}`)
    process.exit(1)
  }
}

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
  console.log('Downloading GUI from npm...\n')

  // Install dependencies (includes @marineyachtradar/mayara-gui)
  run('npm install')

  // Copy files from package root (no dist/ folder)
  const guiSource = path.join(scriptDir, 'node_modules', '@marineyachtradar', 'mayara-gui')

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
