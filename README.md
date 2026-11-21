# Sokoban solver — make.fun sokoban-solver-01-run-20261121

One program (`main.ts`, Node 22, no dependencies) answers all 5 instances
of a set in one run. A generated level is a hallway with rooms off it; a box
pushed out of a room can never come back, so each room is an independent
problem and the level's optimum is the sum of the rooms' optima.

For every room it runs a push-optimal A* over pushes (a state is the boxes
plus the player's reachable region), with an admissible heuristic — the
cheapest assignment of boxes to goals by walking distance — and two deadlock
prunes: dead squares (no push from there can ever reach a goal) and frozen
2×2 blocks. The first solved state A* pops is push-optimal, so a level
solved room by room takes exactly P* pushes.

Practice set: **1,000,000** (all 5 instances at P*, ~0.4 s for the set;
house baseline plain-astar 1.0.0 scores 200,000 on the same set). Five
freshly drawn sets also scored 1,000,000 each. Deterministic: two runs
write byte-identical outputs.

Competition: https://make.fun/bounty/sokoban-solver-01-run-20261121
