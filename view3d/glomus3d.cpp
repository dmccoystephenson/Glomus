// Glomus in 3D: a Strata web-kit scene that draws whatever the page hands it.
//
// The page owns the world (game/world.js) and turns it into plain arrays in game/view3d.js:
// the ground as a terrain tile, the water as one translucent mesh, each animal as a small mesh posed every
// frame, the light of the hour (sun, moon, ambient), glowing ground as point lights, glints and stars as
// points, and outlines (the spot, tool rings, strokes, rain) as lines. This file keeps the latest copy of each,
// so a lost WebGL context can be rebuilt from it, and draws them. It knows nothing about Glomus's rules.
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

// An animal's body: a mesh built around the origin (facing +X), placed by a model matrix every frame.
struct Body {
    std::vector<float> positions, colors;
    std::vector<uint32_t> indices;
    float model[16] = {1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1};
    uint32_t id = 0;
};

Ground ground;
Water water;
std::vector<Body> bodies;  // by slot; an empty one is a free slot
// The light of the hour: direction to the sun, its intensity and tint, the ambient tint and lift.
float sky[13] = {0.3f, 0.8f, 0.4f, 1.0f, 1.0f, 1.0f, 1.0f, 1.0f, 1.0f, 1.0f, 0.0f, 0.0f, 0.0f};
bool skySet = false;
std::vector<float> glows;   // x, y, z, range, r, g, b, intensity, priority per point light
std::vector<float> points;  // x, y, z, pixels, metres, r, g, b, a, flags per point
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
    m.flags = STRATA_MESH_TRANSLUCENT | STRATA_MESH_COLORS_RGBA;
    if (strata_add_textured_mesh(h.engine, &m, &water.id) != STRATA_OK) water.id = 0;
}

void countMeshes(strata_kit::Host& h) {
    int n = water.id ? 1 : 0;
    for (const Body& b : bodies) n += b.id ? 1 : 0;
    h.meshes = n;
}

void uploadBody(strata_kit::Host& h, Body& b) {
    if (!h.engine) return;
    if (b.id) {
        strata_remove_mesh(h.engine, b.id);
        b.id = 0;
    }
    const int nv = static_cast<int>(b.positions.size() / 3);
    if (nv < 3 || b.indices.empty()) return;
    StrataMesh m{};
    m.positions = b.positions.data();
    m.colors = b.colors.data();
    m.indices = b.indices.data();
    m.vertex_count = nv;
    m.index_count = static_cast<int32_t>(b.indices.size());
    m.color[0] = m.color[1] = m.color[2] = m.color[3] = 1.0f;
    if (strata_add_mesh(h.engine, &m, &b.id) != STRATA_OK) {
        b.id = 0;
        return;
    }
    strata_set_mesh_transform(h.engine, b.id, b.model);
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
    for (Body& b : bodies) {
        b.id = 0;
        uploadBody(h, b);
    }
    countMeshes(h);
}

void strata_kit_build(strata_kit::Host& h, double) {
    if (skySet && h.engine) {
        std::copy(sky, sky + 3, h.toSun);
        strata_set_sun_direction(h.engine, h.toSun);
        h.night = std::clamp((0.05f - sky[1]) / 0.2f, 0.0f, 1.0f);
#if STRATA_ABI_MINOR >= 16
        h.sunIntensity = sky[3];
        h.sunTint = {sky[4], sky[5], sky[6]};
        h.ambientTint = {sky[7], sky[8], sky[9]};
        h.ambientLift = {sky[10], sky[11], sky[12]};
#endif
    }
    for (size_t k = 0; k + 9 <= glows.size(); k += 9)
        h.light(glows[k], glows[k + 1], glows[k + 2], glows[k + 3], {glows[k + 4], glows[k + 5], glows[k + 6]},
                glows[k + 7], static_cast<int>(glows[k + 8]));
    for (size_t k = 0; k + 10 <= points.size(); k += 10)
        h.point(points[k], points[k + 1], points[k + 2], points[k + 3], points[k + 4],
                {points[k + 5], points[k + 6], points[k + 7]}, points[k + 8],
                static_cast<uint32_t>(points[k + 9]) & (STRATA_POINT_SOFT | STRATA_POINT_ON_TOP));
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

// The water: one translucent mesh of nv vertices (xyz, linear RGBA: the alpha is carried but the mesh's own
// alpha is what blends) and ni indices.
STRATA_KIT_EXPORT void g3_set_water(const float* positions, const float* colors, int nv, const uint32_t* indices, int ni,
                                    float alpha) {
    if (nv < 0 || ni < 0 || ni % 3) return;
    water.positions.assign(positions, positions + nv * 3);
    water.colors.assign(colors, colors + nv * 4);
    water.indices.assign(indices, indices + ni);
    water.alpha = alpha;
    uploadWater(strata_kit::host());
    countMeshes(strata_kit::host());
}

// The light of the hour, 13 floats: direction to the sun (xyz; below the horizon the engine's moon lights the
// land), the key light's intensity and tint (rgb), the ambient tint (rgb) and the ambient lift (rgb).
STRATA_KIT_EXPORT void g3_set_sky(const float* p) {
    std::copy(p, p + 13, sky);
    skySet = true;
}

// Point lights: n of (x, y, z, range, r, g, b, intensity, priority). The quality tier keeps the highest priorities.
STRATA_KIT_EXPORT void g3_set_lights(const float* data, int n) {
    glows.assign(data, data + (n > 0 ? n * 9 : 0));
}

// Points (glints, foam, fireflies, stars): n of (x, y, z, pixels, metres, r, g, b, a, STRATA_POINT_* flags).
STRATA_KIT_EXPORT void g3_set_points(const float* data, int n) {
    points.assign(data, data + (n > 0 ? n * 10 : 0));
}

// An animal's body in slot `slot`: nv vertices (xyz around the origin, facing +X; linear RGB) and ni indices.
// nv 0 frees the slot.
STRATA_KIT_EXPORT void g3_set_body(int slot, const float* positions, const float* colors, int nv,
                                   const uint32_t* indices, int ni) {
    if (slot < 0 || slot > 200 || nv < 0 || ni < 0 || ni % 3) return;
    if (static_cast<size_t>(slot) >= bodies.size()) bodies.resize(slot + 1);
    Body& b = bodies[slot];
    b.positions.assign(positions, positions + nv * 3);
    b.colors.assign(colors, colors + nv * 3);
    b.indices.assign(indices, indices + (nv ? ni : 0));
    uploadBody(strata_kit::host(), b);
    countMeshes(strata_kit::host());
}

// Where the bodies stand this frame: n of (slot, then a column-major model matrix of 16 floats).
STRATA_KIT_EXPORT void g3_pose_bodies(const float* data, int n) {
    strata_kit::Host& h = strata_kit::host();
    for (int k = 0; k < n; ++k) {
        const float* p = data + k * 17;
        const int slot = static_cast<int>(p[0]);
        if (slot < 0 || static_cast<size_t>(slot) >= bodies.size()) continue;
        Body& b = bodies[slot];
        std::copy(p + 1, p + 17, b.model);
        if (h.engine && b.id) strata_set_mesh_transform(h.engine, b.id, b.model);
    }
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
