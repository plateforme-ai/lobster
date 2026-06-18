import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";

import { readLineFromStream } from "../src/read_line.js";

test("readLineFromStream resolves on newline", async () => {
  const input = new PassThrough();
  const promise = readLineFromStream(input);
  input.write("yes\n");
  input.end();

  const value = await promise;
  assert.equal(value, "yes");
});

test("readLineFromStream pauses TTY input and removes listeners after newline", async () => {
  const input = new PassThrough() as PassThrough & { isTTY: boolean };
  input.isTTY = true;
  let pauseCalls = 0;
  const originalPause = input.pause.bind(input);
  input.pause = () => {
    pauseCalls++;
    return originalPause();
  };

  const promise = readLineFromStream(input);
  input.write("yes\n");

  const value = await promise;
  assert.equal(value, "yes");
  assert.equal(pauseCalls, 1);
  assert.equal(input.listenerCount("data"), 0);
  assert.equal(input.listenerCount("end"), 0);
  assert.equal(input.listenerCount("close"), 0);
  assert.equal(input.listenerCount("error"), 0);
});

test("readLineFromStream resolves on end without newline", async () => {
  const input = new PassThrough();
  const promise = readLineFromStream(input);
  input.write("partial");
  input.end();

  const value = await promise;
  assert.equal(value, "partial");
});

test("readLineFromStream times out when no input arrives", async () => {
  const input = new PassThrough();
  await assert.rejects(
    () => readLineFromStream(input, { timeoutMs: 5 }),
    /Timed out waiting for input/,
  );
});

test("readLineFromStream pauses TTY input after timeout", async () => {
  const input = new PassThrough() as PassThrough & { isTTY: boolean };
  input.isTTY = true;
  let pauseCalls = 0;
  const originalPause = input.pause.bind(input);
  input.pause = () => {
    pauseCalls++;
    return originalPause();
  };

  await assert.rejects(
    () => readLineFromStream(input, { timeoutMs: 5 }),
    /Timed out waiting for input/,
  );
  assert.equal(pauseCalls, 1);
  assert.equal(input.listenerCount("data"), 0);
  assert.equal(input.listenerCount("end"), 0);
  assert.equal(input.listenerCount("close"), 0);
  assert.equal(input.listenerCount("error"), 0);
});
