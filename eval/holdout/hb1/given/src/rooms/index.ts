import { capsule } from "@tinkered/core";

import { roomApi, roomBoard } from "./contract";

/**
 * The room booking capsule. Others import a file of the feature by its own path (ADR 0160).
 * - `board`: members, rooms and bookings (remote data, keyed by office). Members read their office.
 * - `api`: every change, as a call (rpc).
 */
export const rooms = capsule({ label: "rooms", exports: { board: roomBoard, api: roomApi } });
