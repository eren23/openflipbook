import { describe, expect, it, vi } from 'vitest';
import { nodeToPage } from '@/lib/session-pages';

const state = vi.hoisted(() => ({ row: {
  id: 'child', parent_id: 'parent', session_id: 'world', image_key: 'child.jpg',
  page_title: 'Tower', relation: 'descend', sources: [],
  click_in_parent: { x_pct: .8, y_pct: .3 },
  scene_view: { node_id: 'child', level: 'eye', observer: null, map_crop: null },
  transition_context: { version: 1, source_node_id: 'parent', source_image_key: 'parent.jpg', target_point: { x_pct: .8, y_pct: .3 }, source_view: null, destination_view: null, target_bbox: null, target_geo_id: null, target_provenance: 'tap' },
} }));
vi.mock('@/lib/db', () => ({
  getNode: async () => state.row,
  listNodesByParent: async () => [state.row],
  listNodesBySession: async () => ({ rows: [state.row], next_cursor: null }),
}));
vi.mock('@/lib/env', () => ({ readServerEnv: () => ({ MONGODB_URI: 'mock', MONGODB_DB: 'mock', R2_PUBLIC_BASE_URL: 'https://images.test' }) }));
import { GET as getNode } from '@/app/api/nodes/[id]/route';
import { GET as getChildren } from '@/app/api/nodes/[id]/children/route';
import { GET as getSession } from '@/app/api/sessions/[id]/route';

describe('transition read contract', () => {
  it('round-trips the same source identity, camera, and target through every reader', async () => {
    const request = new Request('http://localhost/api');
    const params = { params: Promise.resolve({ id: 'child' }) };
    const node = await (await getNode(request, params)).json();
    const children = await (await getChildren(request, params)).json();
    const session = await (await getSession(request, params)).json();
    for (const wire of [node, children.children[0], session.nodes[0]]) {
      expect(wire.transition_context).toEqual(state.row.transition_context);
      expect(wire.scene_view).toEqual(state.row.scene_view);
      expect(wire.image_key).toBe('child.jpg');
      expect(nodeToPage(wire)).toMatchObject({ imageKey: 'child.jpg', clickInParent: { xPct: .8, yPct: .3 }, transitionContext: state.row.transition_context });
    }
  });

  it('brings a painted walk back when the session is reopened', async () => {
    // Live 2026-09-24: the node held a paid 4-clip walk and the session
    // reader dropped it, so a reopened page never showed it.
    const walk = { clips: [{ from_shot: 0, to_shot: 1, video_url: 'https://v/a.mp4', model: 'm', seconds: 5 }], shots: [], spent_usd: 0.69, created_at: '2026-09-24T00:00:00Z' };
    Object.assign(state.row, { walk });
    const session = await (await getSession(new Request('http://localhost/api'), { params: Promise.resolve({ id: 'world' }) })).json();
    expect(nodeToPage(session.nodes[0]).walk).toEqual(walk);
  });
});
