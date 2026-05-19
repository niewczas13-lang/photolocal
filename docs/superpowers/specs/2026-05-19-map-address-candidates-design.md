# Map Address Candidates Design

## Goal

Add a map workflow for creating address candidates from a clicked map point, reverse-geocoding them, reviewing them in "Adresy do dodania", and approving them into normal checklist address folders only when confirmed.

## Decisions

- Store clicked addresses in a separate `map_address_candidates` table so they do not immediately pollute `addresses` or checklist folders.
- Use Adresy.app as the first reverse-geocoding provider because it exposes a simple JSON endpoint for nearest PRG addresses. The API key is optional through `ADRESY_APP_API_KEY`.
- Keep the GUGiK/OpenLS/WFS path open for a later provider, but do not block this workflow on XML/GML integration.
- Assign candidates automatically when the point falls inside a `map_polygons` rejonizacja polygon.
- Let users approve candidates with automatic assignment, existing OPP/OSD selection, or a manual new OPP/OSD name.
- Approval creates or reuses the real `addresses` row and creates the appropriate reserve checklist path.

## Data Flow

1. User enables "Dodaj adres" on the map and clicks a point.
2. Frontend sends `lat` and `lng` to the backend.
3. Backend reverse-geocodes the point, finds an optional rejonizacja polygon, and stores a pending candidate.
4. Candidate markers and the "Adresy do dodania" tab show pending candidates.
5. User approves or rejects a candidate.
6. Approval writes the final address and checklist folder; rejection hides the candidate from the map workflow.

## Testing

- Repository tests cover candidate creation, automatic region assignment, approval, checklist creation, and rejection.
- Route tests cover reverse-geocode creation and approval validation without calling the real network.
- Frontend routing tests cover the new map subpage.

