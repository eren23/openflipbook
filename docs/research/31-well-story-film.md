# The Well That Answers Back

2026-09-11. First illustrated story cut, not an interactive quest or product walkthrough.

## Deliverable

`~/Desktop/openflipbook-The-Well-That-Answers-Back-2026-09-11.mp4`

- 77.4 seconds, 1920x1080, 30 fps, H.264 video, stereo AAC audio.
- 14 shots: title, map, street, well, key, tavern, bar, street, workshop,
  warning, two knocks, empty workshop, map, closing title.
- Synthetic narration: installed macOS Daniel voice, 145 words/minute.
- Original synthesized tonal bed and knocks; no third-party music.
- Burned-in narration captions and a separate `subtitles.srt`.
- Unofficial Discworld fan story. No affiliation claimed.

## Sources And Scope

Source directory: `docs/research/assets/well-story-2026-09-11/`.
The `pages/` images were extracted without modifying the saved creation-world ZIP
from `full-world-demo-take4-2026-09-11/world.zip`.

The map, original terracotta-roof street, tavern interior, and workshop interior
are existing world images. One new generated insert, `clue-insert.png`, adds the
brass key, winding mechanism, and warning note. Built-in `image_gen` used the
workshop as a visual reference; its complete prompt is in `clue-prompt.txt`.

This is edited illustrated fiction: smooth 2D pan/zoom over source pixels with
explicit cuts between locations. There are no new video-model calls, animated
characters, exact reconstructed camera moves, or new saved quest/game state.
The clue insert is a film asset, not an edit persisted to the world database.
The workshop is the existing generated interior beside the well, not the new
3D workshop footprint from the earlier map-edit demo.

## Sound Timing

The background bed fades away before the well reveal. Two knocks land at
56.7 and 58.0 seconds. A final knock lands at 74.1 seconds over the closing map.
Each knock has short decaying echoes; these are tails, not additional story beats.
Speech timing is measured from the generated audio; shots expand if necessary
to avoid cutting off narration.

## Verification

- FFprobe: duration 77.400000 seconds, 2322 picture frames, expected codecs and size.
- Full FFmpeg picture/audio decode completed successfully, no decode errors.
- Audio sample peak -2.9 dBFS, mean -26.0 dBFS, no sample clipping.
- Blackdetect reported no black interval of 0.3 seconds or longer.
- Inspected the sampled contact sheet plus full-size key and ending frames.
  The warning is legible, captions fit, and title does not collide with credits.
- Voice performance has not been independently auditioned; this is local
  synthetic narration, not a recorded actor performance.
- `git diff --check` passed. No application logic changed for this story cut.

## Reproduce

With the extracted source images, generated clue insert, installed Daniel voice,
FFmpeg, and the repo's existing Next/Sharp dependency:

```sh
node apps/web/scripts/compose-well-story.mjs ~/Desktop/openflipbook-The-Well-That-Answers-Back-2026-09-11.mp4
```

The composer writes measured timings, source paths, and sound cues to
`film-receipt.json`. Speech is cached when its text is unchanged. All scene
cuts are intentional editorial choices, not claims of continuous spatial motion.
