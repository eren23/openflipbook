import { describe, expect, it } from 'vitest';
import type { Entity, SceneView, TransitionSeed, WorldEntityGeo } from '@openflipbook/config';
import { bindTransitionContext, captureTransition, remapTransition, snapshotView, validTransitionPoint } from './transition-context';

const view: SceneView = { node_id: 'parent', level: 'map', observer: null, map_crop: { x: 0, y: 0, w: 100, h: 60 } };
const point = { x_pct: .8, y_pct: .3 };
const parent = { id: 'parent', image_key: 'original.png', scene_view: view };
const seed: TransitionSeed = { version: 1, source_node_id: 'parent', target_point: point, target_geo_id: 'geo_tower', target_bbox: null, target_provenance: 'tap', source_view: view };

describe('transition evidence', () => {
  it('binds immutable source bytes server-side and freezes both view snapshots', () => {
    const destination: SceneView = { ...view, node_id: 'child', level: 'eye' };
    const ctx = bindTransitionContext(seed, parent, point, destination)!;
    expect(ctx.source_image_key).toBe('original.png');
    expect(ctx.source_view).toEqual(view);
    expect(ctx.destination_view).toEqual(destination);
    destination.level = 'street';
    expect(ctx.destination_view?.level).toBe('eye');
  });
  it('derives context for older clients without assuming an uploaded image is a map', () => {
    expect(bindTransitionContext(undefined, { ...parent, scene_view: null }, point, null)).toMatchObject({ target_point: point, source_view: null, target_provenance: 'tap' });
    expect(bindTransitionContext(undefined, parent, null, null)).toBeNull();
    expect(bindTransitionContext(undefined, null, point, null)).toBeNull();
    expect(bindTransitionContext(undefined, parent, point, null, 'edit')).toBeNull();
  });
  it.each([null, {}, { x_pct: '0.5', y_pct: .5 }, { x_pct: NaN, y_pct: .2 }, { x_pct: Infinity, y_pct: .2 }, { x_pct: -.1, y_pct: .2 }, { x_pct: 1.1, y_pct: .2 }])('rejects bad points %j', p => expect(validTransitionPoint(p)).toBe(false));
  it.each([
    { source_node_id: 'unrelated' }, { source_image_key: 'forged.png' }, { version: 2 },
    { target_point: { x_pct: .2, y_pct: .2 } }, { target_geo_id: { $ne: null } },
    { target_bbox: { x_pct: 0, y_pct: 0, w_pct: 2, h_pct: 1 } },
    { target_provenance: 'imagined' }, { source_view: { ...view, node_id: 'other' } },
    { source_view: { ...view, level: 'unknown' } }, { target_provenance: 'source_bbox' },
  ])('rejects inconsistent client evidence %j', patch => {
    expect(() => bindTransitionContext({ ...seed, ...patch }, parent, point, null)).toThrow();
  });
  it('requires a parent and descent relation for explicit context', () => {
    expect(() => bindTransitionContext(seed, null, point, null)).toThrow();
    expect(() => bindTransitionContext(seed, parent, point, null, 'expand')).toThrow();
    expect(() => bindTransitionContext('bad', parent, point, null)).toThrow();
    expect(() => bindTransitionContext(seed, parent, null, null)).toThrow();
  });
  it('can anchor an explicit selection to a source-image box center', () => {
    const box = { x_pct: .6, y_pct: .1, w_pct: .4, h_pct: .4 };
    const boxed = { ...seed, target_provenance: 'source_bbox', target_bbox: box };
    expect(bindTransitionContext(boxed, parent, null, null)?.target_point).toEqual(point);
    expect(() => bindTransitionContext({ ...boxed, target_point: { x_pct: .3, y_pct: .3 } }, parent, null, null)).toThrow();
  });
  it('captures only a matching appearance on this source and keeps the exact tap', () => {
    const box = { x_pct: .6, y_pct: .1, w_pct: .2, h_pct: .2 };
    const entities = [{ id: 'tower', appearance_bboxes: { parent: box, other: { ...box, x_pct: .1 } } }] as unknown as Entity[];
    const geos = [{ id: 'geo_tower', entity_id: 'tower' }] as WorldEntityGeo[];
    const captured = captureTransition({ nodeId: 'parent', sceneView: view }, point, 'geo_tower', entities, geos)!;
    expect(captured.target_point).toEqual(point);
    expect(captured.target_bbox).toEqual(box);
    box.x_pct = .1;
    expect(captured.target_bbox?.x_pct).toBe(.6);
    expect(captureTransition({ nodeId: 'missing' }, point, 'geo_tower', entities, geos)?.target_bbox).toBeNull();
    expect(captureTransition({ nodeId: null }, point)).toBeUndefined();
    expect(captureTransition({ nodeId: 'parent' }, { x_pct: -1, y_pct: 0 })).toBeUndefined();
  });
  it('keeps invalid camera data unknown instead of fabricating a pose', () => {
    expect(snapshotView(null)).toBeNull();
    expect(snapshotView('bad')).toBeNull();
    expect(snapshotView({ ...view, map_crop: { x: 0, y: 0, w: 0, h: 1 } })).toBeNull();
    expect(snapshotView({ ...view, observer: { pos: { x: 0, y: 0 }, gaze: 0, fov: Infinity, eye_height: 1 } })).toBeNull();
    expect(snapshotView({ ...view, place_form: 'x'.repeat(9000) })).toBeNull();
    const eye = { ...view, observer: { pos: { x: 0, y: 0 }, gaze: 0, fov: 1, eye_height: 1 } };
    expect(snapshotView(eye)).toEqual(eye);
  });
  it('remaps camera and source node references but not the image key or geo identity', () => {
    const ctx = bindTransitionContext(seed, parent, point, { ...view, node_id: 'child' })!;
    const copy = remapTransition(ctx, new Map([['parent', 'fork_parent'], ['child', 'fork_child']]))!;
    expect(copy).toMatchObject({ source_node_id: 'fork_parent', source_image_key: 'original.png', target_geo_id: 'geo_tower', source_view: { node_id: 'fork_parent' }, destination_view: { node_id: 'fork_child' } });
    expect(ctx.source_node_id).toBe('parent');
    expect(remapTransition(ctx, new Map())).toBeNull();
    expect(remapTransition(null, new Map())).toBeNull();
    expect(remapTransition({ ...ctx, source_view: null, destination_view: null }, new Map([['parent', 'fork']]))?.source_view).toBeNull();
  });
});
