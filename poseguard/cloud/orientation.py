"""Apply mounting correction before inference; no display-only pose rotation."""
import math


def direction_score(people):
    best = 0.0
    for person in people:
        box = person.bbox if hasattr(person, 'bbox') else person['bbox']
        confidence = person.confidence if hasattr(person, 'confidence') else person.get('confidence', 0)
        points = person.keypoints if hasattr(person, 'keypoints') else person['keypoints']
        p = [None if k is None else (k.x, k.y, k.confidence) if hasattr(k, 'x')
             else (k[0], k[1], k[2] if len(k) > 2 else 1.0) for k in points]
        visible = lambda i: p[i] is not None and p[i][2] >= .2
        seen = [k for k in p if k is not None and k[2] >= .2]
        if confidence < .25 or len(seen) < 3:
            continue
        score = confidence * .8 + sum(k[2] for k in seen) / len(seen) * .3 + len(seen) * .025
        h = max(1, box[3] - box[1])
        if visible(1) and visible(2) and min(p[1][2], p[2][2]) >= .5:
            span = math.hypot(p[1][0] - p[2][0], p[1][1] - p[2][1])
            if span > h * .015:
                horizontal = abs(p[1][0] - p[2][0]) / span
                score += horizontal - (1 if horizontal < .5 else 0)
        if visible(5) and visible(6):
            sx, sy = (p[5][0]+p[6][0])/2, (p[5][1]+p[6][1])/2
            if visible(0):
                distance = math.hypot(sx-p[0][0], sy-p[0][1])
                if distance > h*.04:
                    upright = (sy-p[0][1])/distance
                    score += 1.8*upright - (1 if upright < .4 else 0)
            span = math.hypot(p[5][0]-p[6][0], p[5][1]-p[6][1])
            if span > h*.05:
                score += .45*abs(p[5][0]-p[6][0])/span
            if visible(11) and visible(12):
                score += .8 if sy < (p[11][1]+p[12][1])/2-h*.06 else -.8
        best = max(best, score)
    return best


class CameraOrientation:
    def __init__(self, rotation='auto', mirror=False):
        self.rotation = 0
        self.mode = None
        self.mirror = False
        self.configure(rotation, mirror)

    def configure(self, rotation, mirror=False):
        mode = str(rotation)
        if mode not in ('auto', '0', '90', '180', '270'):
            raise ValueError('Invalid installation direction')
        if self.mode == mode and self.mirror == mirror:
            return
        self.mode, self.mirror = mode, bool(mirror)
        if mode != 'auto':
            self.rotation = int(mode)
        self.locked = mode != 'auto'
        self.probe_at = 0
        self.agreement = 0
        self.candidate = None

    def process(self, raw, now, infer, rotate, records=lambda p: p):
        old = self.rotation
        frame = rotate(raw, self.rotation, self.mirror)
        people = infer(frame)
        score = direction_score(records(people))
        if self.mode == 'auto' and now >= self.probe_at:
            self.probe_at = now + (5 if self.locked else .6 if people else 2)
            best, best_rotation, best_frame, best_people = score, self.rotation, frame, people
            for rotation in (0, 180, 90, 270):
                if rotation == self.rotation:
                    continue
                candidate = rotate(raw, rotation, self.mirror)
                observed = infer(candidate)
                candidate_score = direction_score(records(observed))
                if candidate_score > best:
                    best, best_rotation, best_frame, best_people = candidate_score, rotation, candidate, observed
            if best_rotation != self.rotation and best > 1 and best > score*1.2+.12:
                self.agreement = self.agreement+1 if self.candidate == best_rotation else 1
                self.candidate = best_rotation
                if self.agreement >= 2 or (score < .3 and best > 1.4):
                    self.rotation, frame, people, self.locked = best_rotation, best_frame, best_people, True
            elif score > 1:
                self.agreement = self.agreement+1 if self.candidate == self.rotation else 1
                self.candidate = self.rotation
                if self.agreement >= 2:
                    self.locked = True
        return frame, people, old != self.rotation
