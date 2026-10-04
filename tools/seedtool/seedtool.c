// seedtool — сиды для фермы NeuroDown по библиотеке cubiomes (Cubitect), версия генерации MC_1_21 (WD, 1.21.4+).
// Исходники cubiomes — ../../../cubiomes-viewer/cubiomes (клон рядом с проектом). Сборка — build.cmd (MSVC).
//
//   seedtool info <seed>                       где что от спавна (JSON)
//   seedtool search [условия] [--count N] [--start S] [--max M]
//       условия — радиус в блоках (от спавна; в Аду — от спавна/8):
//       --village R --rp R --shipwreck R --treasure R --temple R --outpost R --igloo R --ocean_ruin R
//       --trail_ruins R --trial_chambers R --ancient_city R --mansion R --monument R --swamp_hut R
//       --bastion R --fortress R --nether-rp R --sh R
//   Печатает по строке JSON на каждый подошедший сид (как info).
//
// Чего cubiomes НЕ знает: лава (озёра — фичи, не структуры), содержимое сундуков, рельеф под
// деревней (в 1.18+ деревня может не встать на склоне). Позиции — точка генерации структуры,
// /locate на сервере даёт то же место ±16 блоков; проверять на сервере, если важно.
#include "finders.h"
#include "generator.h"
#include "util.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <math.h>
#include <time.h>

#define MC MC_1_21

typedef struct { const char *name; int type; int nether; } Kind;
static const Kind KINDS[] = {
    { "village", Village, 0 },
    { "rp", Ruined_Portal, 0 },
    { "shipwreck", Shipwreck, 0 },
    { "treasure", Treasure, 0 },
    { "desert_pyramid", Desert_Pyramid, 0 },
    { "jungle_temple", Jungle_Temple, 0 },
    { "outpost", Outpost, 0 },
    { "igloo", Igloo, 0 },
    { "ocean_ruin", Ocean_Ruin, 0 },
    { "trail_ruins", Trail_Ruins, 0 },
    { "trial_chambers", Trial_Chambers, 0 },
    { "ancient_city", Ancient_City, 0 },
    { "mansion", Mansion, 0 },
    { "monument", Monument, 0 },
    { "swamp_hut", Swamp_Hut, 0 },
    { "bastion", Bastion, 1 },
    { "fortress", Fortress, 1 },
    { "nether_rp", Ruined_Portal_N, 1 },
};
#define NKINDS ((int)(sizeof(KINDS) / sizeof(KINDS[0])))

static int64_t parseSeed (const char *s)
{
    char *end = NULL;
    long long v = strtoll(s, &end, 10);
    if (end && *end == '\0' && end != s) return (int64_t)v;
    int32_t h = 0; // текстовый сид — String.hashCode, как в игре
    for (const char *p = s; *p; p++) h = 31 * h + (unsigned char)*p;
    return (int64_t)h;
}

// Ближайшая годная структура типа t к (cx,cz) в радиусе r; g — генератор нужного измерения.
static int nearest (Generator *g, uint64_t seed, int t, int cx, int cz, int r, Pos *out, double *dist)
{
    StructureConfig sc;
    if (!getStructureConfig(t, MC, &sc)) return 0;
    int rs = sc.regionSize * 16;
    int rx0 = floordiv(cx - r, rs), rx1 = floordiv(cx + r, rs);
    int rz0 = floordiv(cz - r, rs), rz1 = floordiv(cz + r, rs);
    double best = 1e18;
    int found = 0;
    for (int rz = rz0; rz <= rz1; rz++) {
        for (int rx = rx0; rx <= rx1; rx++) {
            Pos p;
            if (!getStructurePos(t, MC, seed, rx, rz, &p)) continue;
            double d = hypot((double)(p.x - cx), (double)(p.z - cz));
            if (d > r || d >= best) continue;
            if (!isViableStructurePos(t, g, p.x, p.z, 0)) continue;
            best = d; *out = p; found = 1;
        }
    }
    if (found) *dist = best;
    return found;
}

typedef struct {
    int want[NKINDS]; // радиус или 0
    int sh;           // радиус стронгхолда или 0
} Crit;

static int nearestSh (Generator *g, uint64_t seed, Pos sp, Pos *out, double *dist)
{
    StrongholdIter it;
    initFirstStronghold(&it, MC, seed);
    double best = 1e18;
    for (int i = 0; i < 3; i++) { // первое кольцо — 3 штуки, ближайший всегда в нём
        nextStronghold(&it, g);
        double d = hypot((double)(it.pos.x - sp.x), (double)(it.pos.z - sp.z));
        if (d < best) { best = d; *out = it.pos; }
    }
    *dist = best;
    return 1;
}

// Полная сводка сида; crit != NULL — вернуть 0 при первом несовпадении.
static int report (uint64_t seed, const Crit *crit, int print)
{
    static Generator go, gn;
    static int init = 0;
    if (!init) { setupGenerator(&go, MC, 0); setupGenerator(&gn, MC, 0); init = 1; }
    applySeed(&gn, DIM_NETHER, seed);

    // Дешёвый предфильтр от (0,0) с запасом — до дорогого getSpawn.
    if (crit) {
        for (int k = 0; k < NKINDS; k++) {
            if (!crit->want[k] || !KINDS[k].nether) continue;
            Pos p; double d;
            if (!nearest(&gn, seed, KINDS[k].type, 0, 0, crit->want[k] + 64, &p, &d)) return 0;
        }
    }
    applySeed(&go, DIM_OVERWORLD, seed);
    if (crit) {
        for (int k = 0; k < NKINDS; k++) {
            if (!crit->want[k] || KINDS[k].nether) continue;
            Pos p; double d;
            if (!nearest(&go, seed, KINDS[k].type, 0, 0, crit->want[k] + 512, &p, &d)) return 0;
        }
    }

    Pos sp = getSpawn(&go);
    float sy; int sid = -1;
    mapApproxHeight(&sy, &sid, &go, NULL, sp.x >> 2, sp.z >> 2, 1, 1); // биом поверхности (1.18+: SurfaceNoise не нужен)
    Pos np = { sp.x / 8, sp.z / 8 };
    char buf[4096];
    int n = snprintf(buf, sizeof buf, "{\"seed\":\"%lld\",\"mc\":\"1.21 (cubiomes MC_1_21)\",\"spawn\":[%d,%d],\"biome\":\"%s\"",
                     (long long)(int64_t)seed, sp.x, sp.z, biome2str(MC, getBiomeAt(&go, 4, sp.x >> 2, ((int)sy + 4) >> 2, sp.z >> 2)));
    for (int k = 0; k < NKINDS; k++) {
        int r = crit && crit->want[k] ? crit->want[k] : (KINDS[k].nether ? 400 : 1000);
        Generator *g = KINDS[k].nether ? &gn : &go;
        Pos c = KINDS[k].nether ? np : sp;
        Pos p; double d;
        if (nearest(g, seed, KINDS[k].type, c.x, c.z, r, &p, &d)) {
            n += snprintf(buf + n, sizeof buf - n, ",\"%s\":{\"x\":%d,\"z\":%d,\"d\":%d}", KINDS[k].name, p.x, p.z, (int)d);
        } else {
            if (crit && crit->want[k]) return 0;
            n += snprintf(buf + n, sizeof buf - n, ",\"%s\":null", KINDS[k].name);
        }
    }
    Pos shp; double shd;
    nearestSh(&go, seed, sp, &shp, &shd);
    if (crit && crit->sh && shd > crit->sh) return 0;
    n += snprintf(buf + n, sizeof buf - n, ",\"sh\":{\"x\":%d,\"z\":%d,\"d\":%d,\"nether\":[%d,%d]}}", shp.x, shp.z, (int)shd, shp.x / 8, shp.z / 8);
    if (print) { puts(buf); fflush(stdout); }
    return 1;
}

static uint64_t splitmix (uint64_t *x)
{
    uint64_t z = (*x += 0x9E3779B97F4A7C15ULL);
    z = (z ^ (z >> 30)) * 0xBF58476D1CE4E5B9ULL;
    z = (z ^ (z >> 27)) * 0x94D049BB133111EBULL;
    return z ^ (z >> 31);
}

static void usage (void)
{
    fputs("seedtool info <seed>\n"
          "seedtool search [--village R] [--rp R] [--shipwreck R] [--treasure R] [--temple R] [--outpost R]\n"
          "                [--bastion R] [--fortress R] [--nether-rp R] [--sh R] [--count N] [--start S] [--max M]\n"
          "  радиусы в блоках: верхний мир — от спавна, Ад — от спавна/8; --temple = пустынный ИЛИ джунглевый храм\n", stderr);
}

int main (int argc, char **argv)
{
    if (argc < 2) { usage(); return 2; }
    if (!strcmp(argv[1], "info")) {
        if (argc < 3) { usage(); return 2; }
        for (int i = 2; i < argc; i++) report((uint64_t)parseSeed(argv[i]), NULL, 1);
        return 0;
    }
    if (strcmp(argv[1], "search")) { usage(); return 2; }

    Crit c; memset(&c, 0, sizeof c);
    int count = 5, temple = 0;
    long long maxScan = 50000000LL;
    uint64_t start = 0; int haveStart = 0;
    for (int i = 2; i < argc; i++) {
        const char *a = argv[i];
        const char *v = i + 1 < argc ? argv[i + 1] : NULL;
        if (!v) { usage(); return 2; }
        i++;
        if (!strcmp(a, "--count")) count = atoi(v);
        else if (!strcmp(a, "--max")) maxScan = atoll(v);
        else if (!strcmp(a, "--start")) { start = (uint64_t)parseSeed(v); haveStart = 1; }
        else if (!strcmp(a, "--sh")) c.sh = atoi(v);
        else if (!strcmp(a, "--temple")) temple = atoi(v);
        else {
            int ok = 0;
            const char *name = a + 2;
            char tmp[32];
            if (!strcmp(name, "nether-rp")) name = "nether_rp";
            snprintf(tmp, sizeof tmp, "%s", name);
            for (int k = 0; k < NKINDS; k++) if (!strcmp(KINDS[k].name, tmp)) { c.want[k] = atoi(v); ok = 1; }
            if (!ok) { fprintf(stderr, "неизвестное условие %s\n", a); usage(); return 2; }
        }
    }
    uint64_t rng = haveStart ? start : ((uint64_t)time(NULL) * 0x2545F4914F6CDD1DULL ^ (uint64_t)clock());
    int got = 0;
    for (long long i = 0; i < maxScan && got < count; i++) {
        uint64_t seed = haveStart ? start + (uint64_t)i : splitmix(&rng);
        if (temple) {
            // храм любого вида — отдельной проверкой (условие «или»)
            Crit c2 = c;
            int okAny = 0;
            for (int k = 0; k < NKINDS && !okAny; k++) {
                if (KINDS[k].type != Desert_Pyramid && KINDS[k].type != Jungle_Temple) continue;
                c2.want[k] = temple;
                if (report(seed, &c2, 0)) okAny = 1;
                c2.want[k] = 0;
            }
            if (!okAny) continue;
            report(seed, &c, 1);
        } else if (!report(seed, &c, 1)) continue;
        got++;
    }
    if (got < count) fprintf(stderr, "найдено %d из %d за %lld сидов\n", got, count, maxScan);
    return got ? 0 : 1;
}
