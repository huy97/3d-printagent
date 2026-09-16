import { VirtualDriver } from './virtual.js';
import { OctoPrintDriver } from './octoprint.js';
import { MoonrakerDriver } from './moonraker.js';
import { PrusaLinkDriver } from './prusalink.js';
import { BambuDriver } from './bambu.js';
import { CAPABILITY_KEYS } from './base.js';
import { badRequest } from '../util/errors.js';

export const DRIVERS = {
  octoprint: OctoPrintDriver,
  moonraker: MoonrakerDriver,
  prusalink: PrusaLinkDriver,
  bambu: BambuDriver,
  virtual: VirtualDriver,
};

export function driverClass(id) {
  const Driver = DRIVERS[id];
  if (!Driver) throw badRequest('error.driver_unknown', { driver: id, supported: Object.keys(DRIVERS).join(', ') });
  return Driver;
}

export function createDriver(printer, context) {
  return new (driverClass(printer.driver))(printer, context);
}

export function secretFields(id) {
  return driverClass(id)
    .fields.filter((field) => field.secret)
    .map((field) => field.key);
}

export function describeDrivers() {
  return Object.values(DRIVERS).map((Driver) => ({
    id: Driver.id,
    label: Driver.label,
    formats: Driver.formats,
    fields: Driver.fields,
    defaults: Driver.defaults,
    capabilities: Object.fromEntries(CAPABILITY_KEYS.map((key) => [key, Boolean(Driver.capabilities[key])])),
    calibrations: Driver.calibrations ?? [],
  }));
}
