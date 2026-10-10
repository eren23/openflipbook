# 43. Judge consistency: source-first identity checks

Date: 2026-10-10. World: the fantasy-town artwork from research 40 to 42.
Spend: $0 for generation. Judge tokens only: 20 judge runs and 1 labelling run,
all Sonnet. Receipts, tasks and verdicts:
`~/Videos/openflipbook/consistency-2026-10-10/variance/` (not in the repo).

Research 42 said that judges give different verdicts on the same bytes. This
note measures that claim and tests a new identity task.

## Method

- Stills: P1 to P4 of the October 8 walk, gate binding `a9038d84`. Every run
  judges the same bytes.
- v1: the source identity task of the research 42 gate. Run 0 is the gate
  re-judge. Two new runs per still.
- v2: the same rules and two additions. Three runs per still.
  - One comparison sheet per landmark: the source map crop, the predecessor
    window and the candidate window. A local SIFT similarity fit matches the
    two windows. The area outside a frame is flat grey.
  - A fixed procedure: identify each building against all four source crops,
    compare it with its source crop first, then compare the predecessor
    inventory. Each building gets a verdict, and the worst one is the overall
    verdict.
- Landmark boxes: one labelling agent, with a 100 px grid on each still and
  all four source crops.

## Results

| Still | v1 (3 runs) | v2 (3 runs) |
|---|---|---|
| P1 | FAIL, UNCERTAIN, FAIL | FAIL, FAIL, FAIL |
| P2 | PASS, PASS, PASS | UNCERTAIN, FAIL, FAIL |
| P3 | PASS, PASS, PASS | FAIL, FAIL, UNCERTAIN |
| P4 | PASS, PASS, PASS | PASS, PASS, PASS |

FAIL and UNCERTAIN both block. Pass or block agrees in 24 of 24 runs.

## Findings

- The judges are stable from run to run with a fixed task. The verdict changes
  in research 42 came from task changes: P2 as the start and P2 as a step after
  P1. A screening task without an identification step also mixed up the Inn
  and the Bookshop.
- v1 anchors on the predecessor. P2 and P3 keep the P1 Forge: a red brick
  chimney (the source chimney is grey stone) and a round gable window. v1
  failed P1 for this chimney in 2 of 3 runs, but passed P2 and P3 in 6 of 6.
- v2 blocks P2 and P3 for the same features. The judges list the Forge chimney
  and the round window, and in one P3 run also the Inn walls and the
  conservatory facets. P4, with the Forge out of view, passes 3 of 3.
- 6 of 12 v2 judges did not write the per-building field. The task builder now
  marks the field as required.

## Consequences

- Use v2 for source identity. The route context task does not change.
- A walk can pass only from a start that matches the source. A still that
  copies its predecessor keeps the errors of the predecessor, and v2 finds
  them.
- Limits: 3 runs per still, one walk, one judge model. One agent made the
  landmark labels, and v2 asks the judges to check them.

## Tools (local, not in the repo)

- `tools/sheets.py`: makes one comparison sheet per labelled landmark.
- `gate/prepare-stills.mjs`: with `SHEETS=<sheets.json>`, it adds the sheets and
  the procedure to the source identity tasks.
- `tools/prompts/label-landmarks.md`: the labelling task.
