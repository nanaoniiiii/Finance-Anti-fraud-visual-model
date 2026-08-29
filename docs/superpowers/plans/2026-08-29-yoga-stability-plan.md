# Yoga Scene Stability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stabilize single-person dynamic yoga scenes by rejecting implausible poses, merging duplicate observations, confirming tracks over time, and using keypoint motion in lingering decisions.

**Architecture:** Add a backend-neutral observation-quality stage between pose inference and tracking. Extend track state with confirmation hits and normalized pose motion. Keep risk rules independent of YOLO and consume the new motion signal only for lingering reset behavior.

**Tech Stack:** Python 3.11, NumPy, OpenCV, pytest, existing backend-neutral dataclasses.

---

### Task 1: Pose observation quality and duplicate suppression

**Files:**
- Create: `poseguard/tracking/observation_filter.py`
- Create: `tests/test_observation_filter.py`
- Modify: `poseguard/app.py`
- Modify: `poseguard/config.py`
- Modify: `configs/windows.json`

- [ ] Write tests proving low-keypoint clutter is rejected, a valid side pose survives, and overlapping skeleton-equivalent observations collapse to the higher-quality observation.
- [ ] Run `python -m pytest tests/test_observation_filter.py -q` and confirm failure before implementation.
- [ ] Implement `PoseObservationFilter.filter(observations, frame_size)` and wire it immediately after `PoseBackend.infer()`.
- [ ] Run the focused tests and commit.

### Task 2: Confirmed tracks and normalized pose motion

**Files:**
- Modify: `poseguard/types.py`
- Modify: `poseguard/tracking/person_tracks.py`
- Modify: `tests/test_tracking.py`

- [ ] Write tests proving a track is unpublished for two frames, published with the same ID on frame three, and reports nonzero normalized pose motion when limbs move.
- [ ] Run the focused tests and confirm failure.
- [ ] Add `hits`, `confirmed`, and `pose_motion` to `PersonTrack`; preserve tentative tracks internally while returning only confirmed tracks.
- [ ] Run tracking and risk tests and commit.

### Task 3: Motion-aware lingering and compact overlay

**Files:**
- Modify: `poseguard/risk/risk_engine.py`
- Modify: `poseguard/ui/overlay.py`
- Modify: `poseguard/app.py`
- Modify: `tests/test_risk_engine.py`
- Modify: `tests/test_overlay.py`

- [ ] Write a test proving visible keypoint motion resets the lingering qualification window.
- [ ] Write a test proving long combined labels split into at most two drawable lines and recent events are de-duplicated.
- [ ] Implement the minimum risk and overlay changes.
- [ ] Run all tests, compile, `git diff --check`, then repeat a 120-frame camera smoke test.
