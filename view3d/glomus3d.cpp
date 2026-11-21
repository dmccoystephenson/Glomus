// Glomus in 3D: a Strata web-kit scene that draws whatever the page hands it.
//
// The page owns the world (game/world.js) and turns it into plain arrays in game/view3d.js:
// the ground as a terrain tile, the water as one translucent mesh, animals as small spheres and
// outlines (the spot, tool rings, strokes, rain) as lines. This file keeps the latest copy of each, so a lost
// WebGL context can be rebuilt from it, and draws them. It knows nothing about Glomus's rules.
//
// Built with Strata's web kit (build.sh); the outputs in game/3d/ are committed.
#define STRATA_KIT_MAIN
#include "strata_kit.h"

#include <vector>

namespace {

struct Ground {
    int nx = 0, nz = 0;
    float cell = 1.0f, x0 = 0.0f, z0 = 0.0f;
    std::vector<float> heights, colors;
};
struct Water {
    std::vector<float> positions, colors;
    std::vector<uint32_t> indices;
    float alpha = 0.7f;
    uint32_t id = 0;
};

Ground ground;
Water water;
std::vector<float> marks;  // x, y, z, radius, r, g, b per animal
std::vector<float> lines;  // x0, y0, z0, x1, y1, z1, r, g, b, a per segment
std::vector<float> wide;   // the same, then width in pixels, width in metres and STRATA_LINES_* flags

void uploadGround(strata_kit::Host& h) {
    if (!h.engine || ground.nx < 2 || ground.nz < 2) return;
    StrataTerrainTile tile{};
    tile.origin[0] = ground.x0;
    tile.origin[1] = 0.0f;
    tile.origin[2] = ground.z0;
    tile.cell_size = ground.cell;
    tile.samples_x = ground.nx;
    tile.samples_z = ground.nz;
    tile.heights = ground.heights.data();
    tile.colors = ground.colors.data();
    tile.color[3] = 1.0f;
    strata_set_terrain(h.engine, &tile);
    h.terrainSamples = ground.nx * ground.nz;
}

void uploadWater(strata_kit::Host& h) {
    if (!h.engine) return;
    if (water.id) {
        strata_remove_mesh(h.engine, water.id);
        water.id = 0;
    }
    const int nv = static_cast<int>(water.positions.size() / 3);
    if (nv < 3 || water.indices.empty()) {
        h.meshes = 0;
        return;
    }
    StrataTexturedMesh m{};
    m.mesh.positions = water.positions.data();
    m.mesh.colors = water.colors.data();
    m.mesh.indices = water.indices.data();
    m.mesh.vertex_count = nv;
    m.mesh.index_count = static_cast<int32_t>(water.indices.size());
    m.mesh.color[0] = m.mesh.color[1] = m.mesh.color[2] = 1.0f;
    m.mesh.color[3] = water.alpha;
    m.flags = STRATA_MESH_TRANSLUCENT;
    if (strata_add_textured_mesh(h.engine, &m, &water.id) != STRATA_OK) water.id = 0;
    h.meshes = water.id ? 1 : 0;
}

}  // namespace

void strata_kit_configure(strata_kit::Options& o) {
    o.name = "glomus3d";
    o.farPlane = 600.0f;
    o.shadowDistanceMin = 120.0f;
}

// Again after a lost context comes back: the engine is new, so everything goes up again.
void strata_kit_engine_ready(strata_kit::Host& h) {
    water.id = 0;
    uploadGround(h);
    uploadWater(h);
}

void strata_kit_build(strata_kit::Host& h, double) {
    for (size_t k = 0; k + 7 <= marks.size(); k += 7) {
        const float r = marks[k + 3];
        h.add(STRATA_PRIMITIVE_SPHERE, marks[k], marks[k + 1] + r, marks[k + 2], r * 2, r * 2, r * 2,
              {marks[k + 4], marks[k + 5], marks[k + 6]});
    }
    for (size_t k = 0; k + 10 <= lines.size(); k += 10)
        h.line(lines[k], lines[k + 1], lines[k + 2], lines[k + 3], lines[k + 4], lines[k + 5],
               {lines[k + 6], lines[k + 7], lines[k + 8]}, lines[k + 9]);
    for (size_t k = 0; k + 13 <= wide.size(); k += 13)
        h.wideLine(wide[k], wide[k + 1], wide[k + 2], wide[k + 3], wide[k + 4], wide[k + 5],
                   {wide[k + 6], wide[k + 7], wide[k + 8]}, wide[k + 10], wide[k + 11], wide[k + 9],
                   static_cast<uint32_t>(wide[k + 12]) & (STRATA_LINES_ON_TOP | STRATA_LINES_ROUND_CAPS));
}

// The ground: nx * nz heights and linear RGB colours, sample (0, 0) at (x0, z0).
STRATA_KIT_EXPORT void g3_set_ground(const float* heights, const float* colors, int nx, int nz, float cell, float x0,
                                     float z0) {
    if (nx < 2 || nz < 2 || nx > 1025 || nz > 1025) return;
    ground.nx = nx;
    ground.nz = nz;
    ground.cell = cell;
    ground.x0 = x0;
    ground.z0 = z0;
    ground.heights.assign(heights, heights + nx * nz);
    ground.colors.assign(colors, colors + nx * nz * 3);
    uploadGround(strata_kit::host());
}

// The water: one translucent mesh of nv vertices (xyz, linear RGB) and ni indices.
STRATA_KIT_EXPORT void g3_set_water(const float* positions, const float* colors, int nv, const uint32_t* indices, int ni,
                                    float alpha) {
    if (nv < 0 || ni < 0 || ni % 3) return;
    water.positions.assign(positions, positions + nv * 3);
    water.colors.assign(colors, colors + nv * 3);
    water.indices.assign(indices, indices + ni);
    water.alpha = alpha;
    uploadWater(strata_kit::host());
}

// Animals: n of (x, y, z, radius, r, g, b), standing on y.
STRATA_KIT_EXPORT void g3_set_marks(const float* data, int n) {
    marks.assign(data, data + (n > 0 ? n * 7 : 0));
}

// Outlines: n segments of (x0, y0, z0, x1, y1, z1, r, g, b, a).
STRATA_KIT_EXPORT void g3_set_lines(const float* data, int n) {
    lines.assign(data, data + (n > 0 ? n * 10 : 0));
}

// Wide outlines: n segments of (x0, y0, z0, x1, y1, z1, r, g, b, a, width in pixels, width in metres, flags),
// drawn as wide as the wider of the two on screen. Flags are STRATA_LINES_ON_TOP (shows through hills) and
// STRATA_LINES_ROUND_CAPS.
STRATA_KIT_EXPORT void g3_set_wide_lines(const float* data, int n) {
    wide.assign(data, data + (n > 0 ? n * 13 : 0));
}
