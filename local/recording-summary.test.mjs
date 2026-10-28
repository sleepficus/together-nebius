// Authored by Way for the new shared Nemotron recording campaign.
// Acceptance cases only; no implementation or additional hidden requirements.
import test from 'node:test';
import assert from 'node:assert/strict';
import {summarizeChecks} from './summary.mjs';

test('empty, null and undefined input remain not-checked with zero counts', () => {
  for (const input of [[], null, undefined]) {
    assert.deepEqual(summarizeChecks(input), {
      status: 'not-checked', total: 0, passed: 0, failed: 0, notChecked: 0,
    });
  }
});

test('one explicitly passed check is passed', () => {
  assert.deepEqual(summarizeChecks([{status: 'passed'}]), {
    status: 'passed', total: 1, passed: 1, failed: 0, notChecked: 0,
  });
});

test('every explicit pass is counted', () => {
  assert.deepEqual(summarizeChecks([
    {status: 'passed'}, {status: 'passed'}, {status: 'passed'},
  ]), {status: 'passed', total: 3, passed: 3, failed: 0, notChecked: 0});
});

test('failure dominates passed and unchecked rows without dropping either', () => {
  assert.deepEqual(summarizeChecks([
    {status: 'passed'}, {status: 'failed'}, {status: 'not-checked'}, null,
  ]), {status: 'failed', total: 4, passed: 1, failed: 1, notChecked: 2});
});

test('a missing status prevents a mixed list from becoming passed', () => {
  assert.deepEqual(summarizeChecks([{status: 'passed'}, {}]), {
    status: 'not-checked', total: 2, passed: 1, failed: 0, notChecked: 1,
  });
});

test('pending, unknown, missing, null and explicit unchecked rows all count', () => {
  assert.deepEqual(summarizeChecks([
    {status: 'pending'}, {status: 'ready'}, {}, null, {status: 'not-checked'},
  ]), {status: 'not-checked', total: 5, passed: 0, failed: 0, notChecked: 5});
});

test('multiple failures are counted rather than stopping at the first', () => {
  assert.deepEqual(summarizeChecks([
    {status: 'failed'}, {status: 'passed'}, {status: 'failed'}, {},
  ]), {status: 'failed', total: 4, passed: 1, failed: 2, notChecked: 1});
});

test('repeated input rows are counted as rows, not deduplicated', () => {
  const row = {status: 'passed'};
  assert.deepEqual(summarizeChecks([row, row]), {
    status: 'passed', total: 2, passed: 2, failed: 0, notChecked: 0,
  });
});

test('the same checks in a different order have the same summary', () => {
  const expected = {status: 'failed', total: 3, passed: 1, failed: 1, notChecked: 1};
  assert.deepEqual(summarizeChecks([
    {status: 'passed'}, {}, {status: 'failed'},
  ]), expected);
  assert.deepEqual(summarizeChecks([
    {status: 'failed'}, {status: 'passed'}, {},
  ]), expected);
});

test('the input array and records are not mutated', () => {
  const input = Object.freeze([
    Object.freeze({status: 'passed'}), Object.freeze({}),
  ]);
  assert.deepEqual(summarizeChecks(input), {
    status: 'not-checked', total: 2, passed: 1, failed: 0, notChecked: 1,
  });
  assert.deepEqual(input, [{status: 'passed'}, {}]);
});
