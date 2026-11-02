import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { extensionFor, screenshotFilename } from '../src/kernel/feedback/files.ts';

describe('extensionFor', () => {
  it('maps the formats the capture produces', () => {
    assert.equal(extensionFor('image/webp'), 'webp');
    assert.equal(extensionFor('image/jpeg'), 'jpg');
    assert.equal(extensionFor('image/png'), 'png');
  });

  it('falls back to png — what a canvas returns for a type it cannot encode', () => {
    assert.equal(extensionFor('application/octet-stream'), 'png');
    assert.equal(extensionFor(''), 'png');
  });
});

describe('screenshotFilename', () => {
  it('names the attachment after its type', () => {
    assert.equal(screenshotFilename('image/webp'), 'screenshot.webp');
  });
});
