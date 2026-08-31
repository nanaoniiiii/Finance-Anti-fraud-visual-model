# PoseGuard README Cross-Platform Architecture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rewrite the root README so PoseGuard is introduced as a serverless edge-processing product, documents its algorithmic improvements over a conventional pose pipeline, and organizes deployment support by runtime architecture rather than three named boards.

**Architecture:** Keep one root README as the project entry point. Present the shared tracking and risk engine first, then explain three runtime classes—general computing, edge AI SoC, and MCU/TinyML—and use tested devices only as examples of those classes. Preserve the existing platform commands and licensing boundary.

**Tech Stack:** Markdown, Git, existing Python/RKNN/MaixPy/C++17/TinyML platform documentation.

---

### Task 1: Rewrite the project overview and optimization comparison

**Files:**
- Modify: `README.md:1-97`
- Reference: `docs/superpowers/specs/2026-08-31-readme-platform-architecture-design.md`

- [ ] **Step 1: Replace the first-screen overview**

Use the title `# PoseGuard 多端金融反诈视觉辅助预警` and state all of the following before any installation command:

- local multi-person pose tracking and suspicious-risk assistance;
- independent operation in weak-network or offline environments;
- no separate local server or cloud inference service;
- reduced deployment, upgrade, and debugging cost;
- focus on rural, remote, and financial-safety-literacy-limited scenarios;
- three current risk types: multiple people, suspected phone-to-ear call, and lingering;
- red indicates manual attention only, not identity, illegality, or fraud conclusions.

- [ ] **Step 2: Add the conventional-versus-PoseGuard comparison table**

Add a three-column table named `核心算法与结构优化` with these exact comparison topics:

1. single-frame threshold versus candidate/confirm/hold/release state machine;
2. frame-independent detections versus stable ID, smoothing, dropout hold, and track recovery;
3. fixed pixel thresholds versus body-scale-normalized geometry;
4. full-frame continuous phone detection versus wrist-ear prefilter and conditional ROI detection;
5. model-coupled decisions versus inference/adapter/tracking/risk/output layers;
6. one shared model binary versus shared semantics with platform-specific model artifacts;
7. mixed RKNN output quantization versus four independent INT8 output scales;
8. one heavyweight Python stack versus platform-appropriate Python, C++17, Maix/K230, and TinyML runtimes;
9. fixed camera index versus UVC discovery, capability validation, and reconnect;
10. per-client JPEG encoding versus one encoded frame shared by stream clients;
11. raw-frame event storage versus de-identified state-transition JSONL.

- [ ] **Step 3: Add the three runtime classes**

Create `按运行环境分类的多端适配` with these subsections:

- `通用计算平台`: Windows/Linux, x86-64/ARM64, CPU/CUDA, full 17-point pose, conditional phone detector, complete overlay, and JSONL;
- `边缘 AI SoC`: RK3566/K230/MaixCAM examples, vendor-specific INT8 artifacts, static inputs, lightweight post-processing, bounded buffers, hardware media paths, built-in-camera or UVC recovery, and local output;
- `MCU/TinyML`: ESP32-S3 examples, low-resolution input, reduced keypoints, distillation, pruning, INT8, fixed arrays, integer geometry, and local LED/buzzer/network alerts.

Explicitly say that classification is based on runtime architecture, available acceleration, memory, and camera path—not a board whitelist—and that each platform independently completes camera-to-alert processing.

- [ ] **Step 4: Add the tested-device matrix**

Add columns for device example, runtime class, camera path, inference form, and main optimization. Include:

- household computer;
- MaixCAM;
- RK3566 TaishanPi;
- K230 device;
- ESP32-S3 device.

Use user-confirmed deployment coverage without adding unsupported performance numbers. For RK3566, state that local-video, model, deployment, and boot-service tests passed while USB hot-plug shooting remains a follow-up. Do not claim every platform's complete firmware is present in this branch.

- [ ] **Step 5: Preserve and reorder operational content**

Keep the existing Windows commands, model-file notes, original-module boundary, license notice, MaixCAM deployment commands, and RK3566 build/deploy commands. Rename device-oriented headings as concrete examples below the architecture overview rather than the definition of project scope.

### Task 2: Validate, commit, and publish the README

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Verify required content and remove the old device-limited wording**

Run:

```powershell
python -c "from pathlib import Path; text=Path('README.md').read_text(encoding='utf-8'); required=['弱网','无需另行部署本地服务器或云端','核心算法与结构优化','通用计算平台','边缘 AI SoC','MCU/TinyML','家用计算机','MaixCAM','RK3566','K230','ESP32-S3','不代表身份、违法事实或诈骗结论']; missing=[item for item in required if item not in text]; assert not missing, missing; assert '后期提供三个互不依赖的端侧版本' not in text"
```

Expected: exit code 0 with no output.

- [ ] **Step 2: Check Markdown whitespace and the exact diff**

Run:

```powershell
git diff --check
git diff -- README.md
```

Expected: `git diff --check` exits 0; the diff changes only the requested README content.

- [ ] **Step 3: Commit the README**

Run:

```powershell
git add README.md docs/superpowers/plans/2026-08-31-readme-platform-architecture-plan.md
git commit -m "docs: explain PoseGuard cross-platform architecture"
```

Expected: one documentation commit with no runtime artifacts.

- [ ] **Step 4: Push and verify the remote hash**

Run:

```powershell
git push github feature/human-risk-pose
git rev-parse HEAD
git rev-parse github/feature/human-risk-pose
```

Expected: both hashes are identical and the working tree is clean.
