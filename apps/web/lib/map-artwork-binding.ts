export interface MapRegistration { x: number; y: number; width: number; rotation: number }
export interface MapRepaintBinding {
  scene_id: string; scene_revision: number; place_id: string;
  scene_source_node_id: string;
  map_root_node_id: string; base_map_node_id: string; baseline_revision: number;
  registration: MapRegistration;
}
