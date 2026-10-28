import { describe, expect, it } from 'vitest';
import { tryParseJson } from './json.js';

describe('tryParseJson', () => {
  it('parses plain JSON, objects and arrays', () => {
    expect(tryParseJson('{"a":1}')).toEqual({ a: 1 });
    expect(tryParseJson('[1,2]')).toEqual([1, 2]);
  });
  it('strips the code fences models like to add, with or without the language', () => {
    expect(tryParseJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(tryParseJson('```JSON\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(tryParseJson('```\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(tryParseJson('  \n{"a":1}\n  ')).toEqual({ a: 1 });
  });
  it('returns undefined, never throws, for anything that is not JSON', () => {
    for (const bad of ['', 'sure, here you go', '{"a":', '```json\nnot json\n```', 'User Safety: safe']) expect(tryParseJson(bad)).toBeUndefined();
  });
  it('keeps a bare JSON value as it is, so the caller can decide that only objects are wanted', () => {
    expect(tryParseJson('"hello"')).toBe('hello');
    expect(tryParseJson('42')).toBe(42);
    expect(tryParseJson('null')).toBeNull();
  });
});
