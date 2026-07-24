// store-filter.test.js — a ClickUp folder counts as a STORE only if it has a Creative Pipeline
// OR Production list (structural, no folder-name blocklist). Fixture mirrors the live workspace:
// the four utility folders drop, the 18 real stores stay.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isStoreFolder } from '../../api/clickup-tasks.js';

const lists = (...names) => ({ lists: names.map((n) => ({ id: n, name: n })) });
const STORE_LISTS = ['Creative Pipeline', 'Production', 'Winners & Scalers', 'Kill List', 'Brand Brain'];

// The live workspace, abridged to the discriminating lists.
const FIXTURE = [
  { name: 'A/B Testing', ...lists('Kindergarten Math Bundle | Nerdytutor', 'Bible Hub') },  // no CP/Prod
  { name: 'Baby Snooze', ...lists(...STORE_LISTS) },
  { name: 'Cake Craft Academy', ...lists(...STORE_LISTS) },
  { name: 'General Tasks', ...lists('List') },                                               // no CP/Prod
  { name: 'Product Research', ...lists('Product Research') },                                 // no CP/Prod
  { name: 'Projects', ...lists('General', 'Spanish Bible', 'RESIN') },                        // no CP/Prod
  { name: 'zenvitals', ...lists(...STORE_LISTS) },
];

test('utility folders (no Creative Pipeline / Production list) are NOT stores', () => {
  for (const name of ['A/B Testing', 'General Tasks', 'Product Research', 'Projects']) {
    assert.equal(isStoreFolder(FIXTURE.find((f) => f.name === name)), false, `${name} should be filtered out`);
  }
});

test('folders with the canonical pipeline lists ARE stores', () => {
  for (const name of ['Baby Snooze', 'Cake Craft Academy', 'zenvitals']) {
    assert.equal(isStoreFolder(FIXTURE.find((f) => f.name === name)), true, `${name} should count as a store`);
  }
});

test('either marker qualifies (Creative Pipeline OR Production), case-insensitive', () => {
  assert.equal(isStoreFolder(lists('creative pipeline')), true);   // CP only, lowercase
  assert.equal(isStoreFolder(lists('PRODUCTION')), true);         // Production only, uppercase
  assert.equal(isStoreFolder(lists('Winners & Scalers')), false); // neither marker
  assert.equal(isStoreFolder({ lists: [] }), false);              // empty folder
  assert.equal(isStoreFolder({}), false);                         // no lists key
});
