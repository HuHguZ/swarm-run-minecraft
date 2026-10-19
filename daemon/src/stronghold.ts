'use strict'

// Поиск крепости оком эндера (mc_stronghold mode=find | throw | solve | blind).
//
// Механика — исходники 1.21.11 (extremeheat/extracted_minecraft_data, ветка
// client1.21.11, и data/ из server-1.21.11.jar; разобрано 2026-09-26):
//   * EnderEyeItem.use: око появляется в точке бросившего (x, y+рост/2, z) и
//     летит к signalTo(Vec3.atLowerCornerOf(findNearestMapStructure(...))) —
//     это StructurePlacement.getLocatePos стартового чанка крепости: угол
//     (16·cx, 0, 16·cz). У strongholds.json locate_offset не задан — ноль.
//     Какая крепость «ближайшая» — по расстоянию до середины чанка
//     (16·cx+8, 32, 16·cz+8), ChunkGenerator.getNearestGeneratedStructure.
//   * EyeOfEnder.signalTo: угол дальше 12 блоков по горизонтали — цель в 12
//     блоках в его сторону и на 8 выше; ближе — сам угол, и око ныряет к y=0.
//     Живёт 80 тиков, потом предмет (surviveAfterDeath = nextInt(5) > 0, 80%)
//     или «разбилось» (20%).
//   * EyeOfEnder.tick / updateDeltaMovement: каждый тик горизонтальная
//     скорость смотрит из следующей точки ПРЯМО на цель, так что по
//     горизонтали око идёт строго по прямой «точка броска → угол чанка»:
//     ~12 блоков за 32 тика (симуляция по формуле), дальше висит у цели.
//     Точка появления приходит точными double (spawn_entity), дальше —
//     дельты в 1/4096 блока (rel_entity_move). Направление по этим двум
//     точкам на 12 блоках — тысячные доли градуса, в разы точнее F3 у
//     человека (0.01°): бот смотрит на само око, как человек перекрестием,
//     только без дрожи руки. Рентгена тут нет — око видно всем.
//   * Крепости сидят на сетке чанков: угол кратен 16. Кольца —
//     ChunkGeneratorStructureState.generateRingPositions (count 128,
//     distance 32, spread 3): радиус кольца k = 4·32 + 6·32·k + (u−0.5)·2.5·32
//     чанков, в кольцах 3, 6, 10, 15, 21, 28, 36, 9 крепостей, потом сдвиг к
//     биому stronghold_biased_to до 112 блоков (findBiomeHorizontal, радиус
//     112, случайная подходящая клетка). Кольцо 0 — 1408..2688 блоков от 0,0.
//   * Старт — StrongholdPieces.StartPiece (StairsDown 5×11×5) от (16cx+2, 64,
//     16cz+2), вся постройка потом опущена (moveBelowSeaLevel: верх не выше
//     seaLevel−10). Лестничная башня — x+2..x+6, z+2..z+6: копать у (x+4, z+4).
//
// Решатель — как у Ninjabrain Bot (байесовский, по чанкам): кандидаты — углы
// чанков вдоль лучей бросков, вес кандидата = плотность колец × правдоподобие
// углов (гаусс, σ из точности замера). Один бросок — список вдоль луча с
// вероятностями, два из разных точек — обычно одна точка с p ≈ 1.
export { mappedRoom, roomApproach, ringDensity, ringOf, RINGS, PLACE, EYE_REACH, POS_ERR } from './stronghold/rings'
export { throwEye } from './stronghold/throw'
export { solve, intersect, candidates, lsPoint, storedThrows, rememberThrow, asRay } from './stronghold/solve'
export { findStronghold, solveStored, blindPlan, blindExpect } from './stronghold/find'
