import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (file: string) => readFileSync(file, "utf8");

test("the optional Linux image pins official CPU wheels and proves they run", () => {
  const wheels = read("services/fashion-vision-cpu-wheels.txt");
  assert.match(
    wheels,
    /download\.pytorch\.org\/whl\/cpu\/torch-2\.15\.0%2Bcpu-cp313-cp313-manylinux_2_28_x86_64\.whl[\s\\]*--hash=sha256:0f6f69701b2d38ddc412364dfb92e2e13e74960d33fa3573b4930ced626e81c7/,
  );
  assert.match(
    wheels,
    /download\.pytorch\.org\/whl\/cpu\/torchvision-0\.29\.2%2Bcpu-py3-none-manylinux_2_28_x86_64\.whl[\s\\]*--hash=sha256:87631236a47be98ab21301e8cb4fc1cbb9325fe0aa7a022e18d2f894087b68c3/,
  );

  const docker = read("Dockerfile");
  const cpuInstall = docker.indexOf("fashion-vision-cpu-wheels.txt");
  const lockInstall = docker.indexOf("-r /tmp/fashion-vision-requirements.txt");
  const smoke = docker.indexOf("import open_clip, torch, torchvision");
  assert.ok(cpuInstall >= 0 && cpuInstall < lockInstall, "CPU wheels install before the cross-platform lock");
  assert.ok(lockInstall < smoke, "the completed environment is import-smoked");
  assert.match(docker, /--require-hashes --no-deps -r \/tmp\/fashion-vision-cpu-wheels\.txt/);
  assert.match(docker, /torch\.tensor\(\[1\]\)\.sum\(\)\.item\(\) == 1/);
});
