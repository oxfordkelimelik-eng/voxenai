# Chest-up Refs + Quality (Head / Gaze / Skin) Implementation Plan

> **For agentic workers:** Execute inline in this session. Spec: `docs/superpowers/specs/2026-09-06-chest-up-refs-quality-design.md`.

**Goal:** Mandatory 3 face + 2 chest-up refs to OpenAI; strengthen head size, gaze, and skin tone via prompt + soft Vision gates.

**Architecture:** Client uploads 5 photos (`photo_0..4`). Server splits first 3 as faces, last 2 as chest-up; reorders best face among faces only. Active production mode `p800` (and sibling prompts) use LAST TWO chest-up contract. Vision keeps binding HEAD_LARGE / BAD_SKIN / BAD_GAZE with clearer bariz criteria.

**Tech Stack:** Flutter (Dart), Cloud Functions (`falPhotos.js`, `faceQuality.js`), OpenAI gpt-image-2 + Vision.

## Global Constraints

- Face-swap stays off.
- No dy/pitch numeric gate.
- Wallet unchanged.
- Priority quality: (1) head size (2) gaze (3) skin tone.
- `REFERENCE_PHOTO_COUNT=5`, `FACE_PHOTO_COUNT=3`, `CHEST_UP_PHOTO_COUNT=2`.

---

### Task 1: Constants + split + prepare

**Files:** `lib/core/constants/dating_constants.dart`, `functions/falPhotos.js`, `functions/faceQuality.js`

- [x] Add `chestUpPhotoCount=2`, `referencePhotoCount=5`
- [x] `splitRefUrls` → `{ faceUrls, chestUrls, bodyUrl:null }`
- [x] Prepare: exact count 5; reorder faces only; enforce chest-up face-ratio band; wire `notFullBodyIndices` messages for chest-up
- [x] `generateForMode` fullSet includes chestUrls

### Task 2: Client capture UX

**Files:** `module_flows.dart`, FAQ, consent

- [x] `_chestUpPhotos`, `_refsReady`, `_allReferencePhotos`
- [x] Gallery pick exactly 2 chest-up; UI section; reset on clear
- [x] Update FAQ + consent copy

### Task 3: Prompts (priority 1–3)

**Files:** `falPhotos.js` — `buildEditPrompt`, `buildEditPromptP800` (production), p300/p1400/short, `bodyProfileHint`

- [x] Replace distant full-body LAST-one contract with LAST TWO chest-up
- [x] Elevate HEAD SIZE, GAZE, SKIN with chest-up cues

### Task 4: Vision soft gates

**Files:** `falPhotos.js` Vision self prompt

- [x] Stricter bariz language for HEAD_LARGE, gaze vs scene, face↔arms/chest skin
- [x] Keep binding classification rules (no dy/pitch gate)
