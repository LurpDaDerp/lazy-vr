/* The JavaScript geometry against what the reference numpy produced. */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  NUM_LANDMARKS,
  SubjectStatistics,
  averageClouds,
  cameraContext,
  combineGaze,
  eyeVisibility,
  gazeAngles,
  landmarkValidity,
  mirrorCloud,
  mirrorContext,
  mirrorValidity,
  rowStatistics,
  weak3dCloud,
} from "../../site/js/geometry.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(readFileSync(join(here, "..", "fixtures", "geometry_parity.json"), "utf-8"));
const flat = (rows) => Float64Array.from(rows.flat());

function close(actual, expected, tolerance, label) {
  assert.equal(actual.length, expected.length, `${label}: length`);
  let worst = 0;
  for (let i = 0; i < actual.length; i++) worst = Math.max(worst, Math.abs(actual[i] - expected[i]));
  assert.ok(worst <= tolerance, `${label}: max |diff| ${worst} exceeds ${tolerance}`);
}

for (const [index, c] of fixture.cases.entries()) {
  const landmarks = flat(c.landmarks);
  const cloud = weak3dCloud(landmarks, c.width, c.height);

  test(`case ${index}: weak3d cloud matches numpy`, () => {
    close(cloud, flat(c.cloud), 1e-12, "cloud");
  });

  test(`case ${index}: camera context matches numpy`, () => {
    close(cameraContext(landmarks, c.width, c.height, fixture.focal_scale), c.context, 1e-12, "context");
  });

  test(`case ${index}: eye statistics match numpy`, () => {
    close(rowStatistics(cloud), c.stats, 1e-12, "stats");
  });

  test(`case ${index}: validity matches numpy`, () => {
    close(landmarkValidity(landmarks), c.validity, 0, "validity");
  });

  test(`case ${index}: eye visibility matches numpy`, () => {
    close(eyeVisibility(cloud, ...fixture.eye_gate), c.eye_visibility, 1e-12, "visibility");
  });

  test(`case ${index}: mirrored cloud matches numpy`, () => {
    close(mirrorCloud(cloud, fixture.permutation), flat(c.mirrored_cloud), 1e-12, "mirror");
  });

  test(`case ${index}: gaze angles match numpy`, () => {
    close(gazeAngles(c.gaze), c.angles, 1e-9, "angles");
  });
}

test("the last case has landmarks out of frame, so validity is exercised", () => {
  const validity = fixture.cases.at(-1).validity;
  assert.ok(validity.some((v) => v === 0) && validity.some((v) => v === 1));
});

test("the running median matches numpy frame by frame", () => {
  const spec = fixture.running_median;
  const stats = new SubjectStatistics(spec.default, spec.window, spec.min_frames);
  fixture.cases.forEach((c, i) => {
    const current = stats.push(weak3dCloud(flat(c.landmarks), c.width, c.height));
    close(current, spec.expected[i], 1e-12, `median after frame ${i}`);
  });
});

test("mirror is an involution on the cloud", () => {
  const cloud = weak3dCloud(flat(fixture.cases[0].landmarks), 640, 480);
  close(mirrorCloud(mirrorCloud(cloud, fixture.permutation), fixture.permutation), cloud, 1e-15, "involution");
});

test("mirror context negates only x", () => {
  assert.deepEqual(mirrorContext([0.1, 0.2, 0.3, 4, 5, 6, 7]), [-0.1, 0.2, 0.3, 4, 5, 6, 7]);
});

test("mirror validity permutes", () => {
  const validity = new Float32Array(NUM_LANDMARKS).fill(1);
  validity[3] = 0;
  const mirrored = mirrorValidity(validity, fixture.permutation);
  assert.equal(mirrored[fixture.permutation.indexOf(3)], 0);
});

test("averaging a cloud with its own flipped detection gives it back", () => {
  // A detection of the flipped frame, if perfect, is the permuted cloud
  // with x -> 1 - x.  Averaging must then reproduce the direct cloud.
  const direct = flat(fixture.cases[0].landmarks);
  const perm = fixture.permutation;
  const flipped = new Float64Array(NUM_LANDMARKS * 3);
  for (let i = 0; i < NUM_LANDMARKS; i++) {
    const j = perm[i];  // landmark i of the flipped frame is landmark j of the face
    flipped[i * 3] = 1 - direct[j * 3];
    flipped[i * 3 + 1] = direct[j * 3 + 1];
    flipped[i * 3 + 2] = direct[j * 3 + 2];
  }
  close(averageClouds(direct, flipped, perm), direct, 1e-15, "average");
});

test("TTA combination un-mirrors x and normalises", () => {
  const out = combineGaze([0.2, 0.1, 0.9], [-0.2, 0.1, 0.9]);
  const norm = Math.hypot(...out);
  assert.ok(Math.abs(norm - 1) < 1e-12);
  assert.ok(out[0] > 0 && Math.abs(out[0] - 0.4 / Math.hypot(0.4, 0.2, 1.8)) < 1e-12);
});

test("forward gaze is zero degrees on both axes", () => {
  const [h, v] = gazeAngles([0, 0, 1]);
  assert.equal(Math.abs(h), 0);
  assert.equal(Math.abs(v), 0);
});

test("a degenerate face is refused rather than producing garbage", () => {
  const collapsed = new Float64Array(NUM_LANDMARKS * 3).fill(0.5);
  assert.throws(() => weak3dCloud(collapsed, 640, 480), /degenerate/);
});
