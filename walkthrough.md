# Photo Local Walkthrough

The `photo-local` application is a self-contained Windows-first photo checklist tool designed for offline use.

## Implemented Features

### Backend
- **Fastify Server**: Handles API requests and serves the frontend.
- **SQLite Database**: Stores project metadata, checklist nodes, and photo records.
- **GPKG Extractor**: Reads GeoPackage files to extract addresses and determine network topology (Single vs Cascade).
- **Checklist Generator**: Automatically creates a hierarchical folder structure based on the project type (SI/KPO) and addresses.
- **Project Creation API**: Handles multipart GPKG uploads, performs automated data extraction, generates checklist nodes, and persists everything in SQLite.
- **Photo Processor**: Uses `sharp` to resize images, generate thumbnails, and `exifr` to extract GPS data.
- **Path Utilities**: Handles Polish characters and ensures safe, unique folder names for the filesystem.

### Frontend
- **React 19 Application**: A clean, modern UI for managing projects.
- **Project List**: Displays all imported projects with their progress.
- **Project Creation Dialog**: Fully wired form that uploads GPKG files and refreshes the list upon success.
- **Checklist View**: A tree-based view of the project's required photos.
- **Photo Dropzone**: Allows drag-and-drop photo uploads.
- **Status Management**: Support for marking nodes as "Not Applicable".

### Deployment & Startup
- **Quiet Startup**: `start.bat` launches the server in a hidden window and opens the browser.
- **Debug Mode**: `debug.bat` runs the server with a visible console for live logs.
- **Robust Shutdown**: `stop.bat` terminates the server using both a PID file and a fallback port-based process kill.
- **Automatic Health Checks**: The startup script waits for the server to be ready before opening the UI.

## Verification Results

### Backend Tests
All backend logic was verified with Vitest:
- `path-names.spec.ts`: 3 tests passed.
- `checklist-generator.spec.ts`: 3 tests passed.
- `gpkg-extractor.spec.ts`: 3 tests passed.
- `photo-processor.spec.ts`: 2 tests passed.
- `projects-routes.spec.ts`: 1 test passed.

### Manual Checks
- **GPKG Extraction**: Verified against `sample.gpkg` (correctly detected 4 splitters and suggested CASCADE topology).
- **Project Creation**: Verified that uploading a GPKG correctly populates the database and checklist.
- **Windows Integration**: Verified `start.bat`, `debug.bat`, and `stop.bat` functionality.

## File Structure

```text
photo-local/
  backend/           # Fastify + SQLite
  frontend/          # React + Vite
  scripts/           # PowerShell startup logic
  start.bat          # User-facing entry point (quiet)
  debug.bat          # User-facing entry point (with logs)
  stop.bat           # User-facing exit point
  walkthrough.md     # This document
```
