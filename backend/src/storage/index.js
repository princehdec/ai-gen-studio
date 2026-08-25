import { config } from '../config.js';

/**
 * Storage driver factory. The rest of the app only ever calls these four
 * functions, so swapping local disk for S3/Cloudinary later means adding a
 * sibling module (e.g. storage/s3.js) with the same exports and flipping
 * STORAGE_DRIVER in .env — no route changes required.
 */
let driver;
switch (config.storageDriver) {
  case 'local':
    driver = await import('./local.js');
    break;
  case 's3':
  case 'cloudinary':
    throw new Error(
      `STORAGE_DRIVER=${config.storageDriver} is not implemented yet. ` +
      'Implement backend/src/storage/' + config.storageDriver + '.js with the same ' +
      'exports as storage/local.js (newRel/saveBuffer/saveWebStream/remove), then restart.',
    );
  default:
    throw new Error(`Unknown STORAGE_DRIVER "${config.storageDriver}" (expected "local" or "s3").`);
}

export const newRel = driver.newRel;
export const saveBuffer = driver.saveBuffer;
export const saveWebStream = driver.saveWebStream;
export const remove = driver.remove;
