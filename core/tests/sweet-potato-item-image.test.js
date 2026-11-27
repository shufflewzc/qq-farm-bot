const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');

const { getItemById, getItemImageById } = require('../dist/config/gameConfig');
const { getResourcePath } = require('../dist/config/runtime-paths');

test('the golden sweet potato resolves to its own PNG icon', () => {
    const itemId = 1040307;
    const imagePath = 'seed_images_named/seed_images/1040307.png';

    assert.equal(getItemById(itemId)?.name, '黄金·红薯');
    assert.equal(getItemImageById(itemId), `/game-config/${imagePath}`);

    const image = fs.readFileSync(getResourcePath('gameConfig', imagePath));
    const seedImage = fs.readFileSync(getResourcePath('gameConfig', 'seed_images_named/seed_images/20307.png'));
    assert.deepEqual(image.subarray(0, 8), Buffer.from('89504e470d0a1a0a', 'hex'));
    assert.equal(image.equals(seedImage), false);
});
