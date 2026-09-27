import React from 'react';
import {AbsoluteFill, Composition, OffthreadVideo, Sequence, registerRoot, staticFile, useCurrentFrame} from 'remotion';

// Frame ranges refer to the verified source trim at native 25 fps. No speed changes.
export const shots = [
  {start: 10, frames: 105, title: 'Draw a house footprint', detail: 'House preset / not AI-generated geometry'},
  {start: 138, frames: 85, title: 'Give it height', detail: 'Courtyard studio / 5.5 m'},
  {start: 223, frames: 157, title: 'Inspect the geometry', detail: 'Orbit the same authored building.'},
  {start: 380, frames: 115, title: 'Change the roof. Apply.', detail: 'Teal tile in both views.'},
  {start: 640, frames: 55, title: 'Still there after reload', detail: 'Save/reload wait omitted.'},
];
const duration = shots.reduce((sum, shot) => sum + shot.frames, 0);
const ink = '#202a28';
const Shot = ({shot}: {shot: typeof shots[number]}) => <AbsoluteFill>
  <div style={{position: 'absolute', top: 60, left: 48, width: 1824, height: 1026, transform: 'scale(0.9)', transformOrigin: 'top center'}}>
    <OffthreadVideo src={staticFile('source.mp4')} trimBefore={shot.start} muted style={{width: '100%', height: '100%'}} />
  </div>
</AbsoluteFill>;

const Pilot = () => {
  const frame = useCurrentFrame();
  let offset = 0;
  const timed = shots.map(shot => {const from = offset; offset += shot.frames; return {...shot, from};});
  const active = timed.findIndex(shot => frame < shot.from + shot.frames);
  const shot = timed[active];
  return <AbsoluteFill style={{backgroundColor: '#f5f7f6', color: ink, fontFamily: 'Arial, sans-serif', letterSpacing: 0}}>
    <div style={{height: 60, padding: '0 48px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', borderBottom: '1px solid #dce2df'}}>
      <span style={{fontWeight: 700, fontSize: 25}}>Openflipbook</span>
      <span style={{fontSize: 18, color: '#566660'}}>WORLD EDITOR / PROCEDURAL 3D EDITING</span>
    </div>
    {timed.map((shot, index) => <Sequence key={index} from={shot.from} durationInFrames={shot.frames}><Shot shot={shot}/></Sequence>)}
    <div style={{position: 'absolute', left: 48, right: 48, bottom: 35, display: 'flex', alignItems: 'center', gap: 24}}>
      <div style={{fontSize: 24, color: '#287766', width: 60, fontVariantNumeric: 'tabular-nums'}}>0{active + 1}</div>
      <div style={{fontSize: 33, fontWeight: 600}}>{shot.title}</div>
      <div style={{marginLeft: 'auto', fontSize: 23, color: '#53655e'}}>{shot.detail}</div>
    </div>
    <div style={{position: 'absolute', bottom: 0, left: 0, right: 0, display: 'flex', gap: 4, height: 4}}>
      {timed.map((item, i) => <div key={i} style={{flex: item.frames, background: '#d7e0db'}}><div style={{height: 4, width: `${Math.max(0, Math.min(1, (frame - item.from + 1) / item.frames)) * 100}%`, background: '#287766'}}/></div>)}
    </div>
  </AbsoluteFill>;
};
registerRoot(() => <Composition id="ProductPilot" component={Pilot} durationInFrames={duration} fps={25} width={1920} height={1080}/>);
