#!/usr/bin/env python3
"""Compare the Anvil worlds of two server directories chunk by chunk.

Block states and biomes are decoded to per-block names so that palette order
and bit packing differences do not count as mismatches. Python 3 stdlib only.
"""
import argparse
import gzip
import json
import os
import re
import struct
import sys
import zlib
from array import array
from multiprocessing import Pool

DIMENSIONS = {
    "overworld": "world/region",
    "nether": "world_nether/DIM-1/region",
    "end": "world_the_end/DIM1/region",
}

# Volatile or derived data that legitimately differs between two fresh generations.
IGNORED_TOP = {
    "LastUpdate", "InhabitedTime", "isLightOn", "PostProcessing", "blending_data",
    "UpgradeData", "CarvingMasks", "block_ticks", "fluid_ticks",
}
HANDLED_TOP = {"DataVersion", "Status", "sections", "block_entities", "Heightmaps", "structures"}

REGION_RE = re.compile(r"^r\.(-?\d+)\.(-?\d+)\.mca$")
SECTION_BLOCKS = 4096
SECTION_BIOMES = 64
HEIGHTMAP_COLUMNS = 256


class Unsupported(Exception):
    pass


# ---------------------------------------------------------------- NBT reader

_FMT = {1: "b", 2: "h", 3: "i", 4: "q", 5: "f", 6: "d"}
_SIZE = {1: 1, 2: 2, 3: 4, 4: 8, 5: 4, 6: 8}
_LITTLE = sys.byteorder == "little"


def _read_str(buf, pos):
    n = struct.unpack_from(">H", buf, pos)[0]
    pos += 2
    return buf[pos:pos + n].decode("utf-8", "replace"), pos + n


def _payload(buf, pos, tag):
    if tag in _SIZE:
        return struct.unpack_from(">" + _FMT[tag], buf, pos)[0], pos + _SIZE[tag]
    if tag == 8:
        return _read_str(buf, pos)
    if tag == 10:
        out = {}
        while True:
            t = buf[pos]
            pos += 1
            if t == 0:
                return out, pos
            name, pos = _read_str(buf, pos)
            out[name], pos = _payload(buf, pos, t)
    if tag == 9:
        t = buf[pos]
        n = struct.unpack_from(">i", buf, pos + 1)[0]
        pos += 5
        if n <= 0:
            return [], pos
        if t in _SIZE:
            values = list(struct.unpack_from(">%d%s" % (n, _FMT[t]), buf, pos))
            return values, pos + n * _SIZE[t]
        values = []
        for _ in range(n):
            v, pos = _payload(buf, pos, t)
            values.append(v)
        return values, pos
    if tag == 7:
        n = struct.unpack_from(">i", buf, pos)[0]
        pos += 4
        return bytes(buf[pos:pos + n]), pos + n
    if tag in (11, 12):
        n = struct.unpack_from(">i", buf, pos)[0]
        pos += 4
        arr = array("i" if tag == 11 else "q")
        arr.frombytes(buf[pos:pos + n * arr.itemsize])
        if _LITTLE:
            arr.byteswap()
        return arr, pos + n * arr.itemsize
    raise ValueError("unknown NBT tag %d" % tag)


def read_nbt(buf):
    """Parse a root compound from decompressed NBT bytes."""
    if buf[0] != 10:
        raise ValueError("root tag is not a compound")
    _, pos = _read_str(buf, 1)
    root, _ = _payload(buf, pos, 10)
    return root


# -------------------------------------------------------------- Anvil reader

class Region:
    def __init__(self, path):
        with open(path, "rb") as f:
            self.data = f.read()
        self.dir = os.path.dirname(path)
        m = REGION_RE.match(os.path.basename(path))
        self.rx, self.rz = int(m.group(1)), int(m.group(2))

    def positions(self):
        if len(self.data) < 4096:
            return
        for i in range(1024):
            if int.from_bytes(self.data[i * 4:i * 4 + 4], "big") >> 8:
                yield i & 31, i >> 5

    def read(self, lx, lz):
        i = lz * 32 + lx
        entry = int.from_bytes(self.data[i * 4:i * 4 + 4], "big")
        offset = (entry >> 8) * 4096
        length = struct.unpack_from(">I", self.data, offset)[0]
        ctype = self.data[offset + 4]
        if ctype & 128:
            cx, cz = self.rx * 32 + lx, self.rz * 32 + lz
            with open(os.path.join(self.dir, "c.%d.%d.mcc" % (cx, cz)), "rb") as f:
                payload = f.read()
            ctype &= 127
        else:
            payload = self.data[offset + 5:offset + 4 + length]
        if ctype == 2:
            raw = zlib.decompress(payload)
        elif ctype == 1:
            raw = gzip.decompress(payload)
        elif ctype == 3:
            raw = payload
        elif ctype == 4:
            raise Unsupported("LZ4 chunk compression (type 4) is not supported")
        else:
            raise Unsupported("unknown chunk compression type %d" % ctype)
        return read_nbt(raw)


# --------------------------------------------------- palette container decode

def block_key(entry):
    props = entry.get("Properties")
    if props:
        return entry["Name"] + "[" + ",".join("%s=%s" % kv for kv in sorted(props.items())) + "]"
    return entry["Name"]


def unpack(longs, bits, count):
    """Unpack values that do not span longs (1.16+ layout)."""
    per = 64 // bits
    mask = (1 << bits) - 1
    out = []
    for v in longs:
        v &= 0xFFFFFFFFFFFFFFFF
        for _ in range(per):
            out.append(v & mask)
            v >>= bits
        if len(out) >= count:
            break
    return out[:count]


def container_keys(container, kind):
    palette = container["palette"]
    return [block_key(e) for e in palette] if kind == "blocks" else list(palette)


def container_values(container, kind, size):
    """Per-cell palette keys, or None marker handled by caller for uniform containers."""
    keys = container_keys(container, kind)
    if len(keys) == 1 or "data" not in container:
        return [keys[0]] * size
    minbits = 4 if kind == "blocks" else 0
    bits = max(minbits, (len(keys) - 1).bit_length())
    return [keys[i] for i in unpack(container["data"], bits, size)]


def compare_container(ca, cb, kind, size):
    """Return None if equal, else (first_index, a_key, b_key, differing_count)."""
    if (container_keys(ca, kind) == container_keys(cb, kind)
            and ca.get("data") == cb.get("data")):
        return None
    va = container_values(ca, kind, size)
    vb = container_values(cb, kind, size)
    if va == vb:
        return None
    first = next(i for i in range(size) if va[i] != vb[i])
    return first, va[first], vb[first], sum(1 for x, y in zip(va, vb) if x != y)


# Light-only sections (above/below the build area) carry no block_states/biomes.
EMPTY_BLOCKS = {"palette": [{"Name": "minecraft:air"}]}


def blocks_of(section):
    return section.get("block_states", EMPTY_BLOCKS)


def is_all_air(section):
    keys = container_keys(blocks_of(section), "blocks")
    return all(k in ("minecraft:air", "minecraft:cave_air", "minecraft:void_air") for k in keys)


# ------------------------------------------------------------ chunk compare

def plain(tag):
    if isinstance(tag, dict):
        return {k: plain(v) for k, v in tag.items()}
    if isinstance(tag, list):
        return [plain(v) for v in tag]
    if isinstance(tag, (array, bytes)):
        return list(tag)
    return tag


def first_diff(a, b, path=""):
    if isinstance(a, dict) and isinstance(b, dict):
        for k in sorted(set(a) | set(b)):
            if k not in a or k not in b:
                return path + "/" + k, a.get(k, "<missing>"), b.get(k, "<missing>")
            r = first_diff(a[k], b[k], path + "/" + k)
            if r:
                return r
        return None
    if isinstance(a, list) and isinstance(b, list):
        if len(a) != len(b):
            return path + "[len]", len(a), len(b)
        for i, (x, y) in enumerate(zip(a, b)):
            r = first_diff(x, y, "%s[%d]" % (path, i))
            if r:
                return r
        return None
    return None if a == b else (path, a, b)


def short(v, limit=200):
    s = repr(v)
    return s if len(s) <= limit else s[:limit] + "..."


def compare_sections(a, b, cx, cz, out):
    sa = {s["Y"]: s for s in a.get("sections", [])}
    sb = {s["Y"]: s for s in b.get("sections", [])}
    for y in sorted(set(sa) | set(sb)):
        x, z = sa.get(y), sb.get(y)
        if x is None or z is None:
            # Empty sections may be omitted by one side (they only exist for light data).
            present = x or z
            if not is_all_air(present):
                out.append({"category": "sections", "section": y,
                            "detail": "section present only in %s" % ("A" if x else "B")})
            continue
        r = compare_container(blocks_of(x), blocks_of(z), "blocks", SECTION_BLOCKS)
        if r:
            i, ka, kb, n = r
            out.append({"category": "block_states", "section": y,
                        "pos": [cx * 16 + (i & 15), y * 16 + (i >> 8), cz * 16 + ((i >> 4) & 15)],
                        "a": ka, "b": kb, "differing_blocks": n})
        if ("biomes" in x) != ("biomes" in z):
            out.append({"category": "biomes", "section": y,
                        "detail": "biomes present only in %s" % ("A" if "biomes" in x else "B")})
            continue
        r = compare_container(x["biomes"], z["biomes"], "biomes", SECTION_BIOMES) if "biomes" in x else None
        if r:
            i, ka, kb, n = r
            out.append({"category": "biomes", "section": y,
                        "pos": [cx * 16 + (i & 3) * 4, y * 16 + (i >> 4) * 4, cz * 16 + ((i >> 2) & 3) * 4],
                        "a": ka, "b": kb, "differing_cells": n})


def compare_heightmaps(a, b, cx, cz, out):
    ha, hb = a.get("Heightmaps", {}), b.get("Heightmaps", {})
    for name in sorted(set(ha) | set(hb)):
        if name not in ha or name not in hb:
            out.append({"category": "heightmaps", "detail": "%s only in %s" % (name, "A" if name in ha else "B")})
        elif ha[name] != hb[name]:
            va, vb = unpack(ha[name], 9, HEIGHTMAP_COLUMNS), unpack(hb[name], 9, HEIGHTMAP_COLUMNS)
            i = next((k for k in range(HEIGHTMAP_COLUMNS) if va[k] != vb[k]), 0)
            out.append({"category": "heightmaps", "detail": name,
                        "pos": [cx * 16 + (i & 15), None, cz * 16 + (i >> 4)],
                        "a": va[i], "b": vb[i]})


def normalize_structures(chunk):
    s = chunk.get("structures", {})
    refs = {k: sorted(v) for k, v in s.get("References", {}).items()}
    return {"starts": plain(s.get("starts", {})), "References": refs}


def compare_block_entities(a, b, out):
    def keyed(chunk):
        return sorted((plain(e) for e in chunk.get("block_entities", [])),
                      key=lambda e: (e.get("x", 0), e.get("y", 0), e.get("z", 0)))
    ea, eb = keyed(a), keyed(b)
    d = first_diff(ea, eb)
    if d:
        path, va, vb = d
        m = re.match(r"\[(\d+)\]", path)
        ref = (ea[int(m.group(1))] if m and int(m.group(1)) < len(ea) else {})
        out.append({"category": "block_entities", "detail": path,
                    "pos": [ref.get("x"), ref.get("y"), ref.get("z")],
                    "a": short(va), "b": short(vb)})


def compare_chunk(a, b, cx, cz):
    """Return a list of findings (empty if the chunks are equivalent)."""
    out = []
    if a.get("DataVersion") != b.get("DataVersion"):
        return [{"category": "data_version", "a": a.get("DataVersion"), "b": b.get("DataVersion")}]
    compare_sections(a, b, cx, cz, out)
    compare_heightmaps(a, b, cx, cz, out)
    d = first_diff(normalize_structures(a), normalize_structures(b))
    if d:
        out.append({"category": "structures", "detail": d[0], "a": short(d[1]), "b": short(d[2])})
    compare_block_entities(a, b, out)
    for key in sorted((set(a) | set(b)) - IGNORED_TOP - HANDLED_TOP):
        d = first_diff(plain(a.get(key, "<missing>")), plain(b.get(key, "<missing>")), "/" + key)
        if d:
            out.append({"category": "other", "detail": d[0], "a": short(d[1]), "b": short(d[2])})
    return out


def is_full(chunk):
    return chunk.get("Status") in ("minecraft:full", "full")


# ------------------------------------------------------------- world compare

def _in_area(cx, cz, radius):
    return radius is None or (abs(cx) <= radius - 1 and abs(cz) <= radius - 1)


def _empty_result():
    return {"chunks_compared": 0, "chunks_mismatched": 0, "full_only_a": 0, "full_only_b": 0,
            "read_errors": 0, "categories": {}, "examples": []}


def compare_region_pair(task):
    path_a, path_b, name, radius, max_examples = task
    res = _empty_result()
    ra = Region(path_a) if os.path.exists(path_a) else None
    rb = Region(path_b) if os.path.exists(path_b) else None
    ref = ra or rb
    rx, rz = ref.rx, ref.rz

    def load(region, lx, lz):
        if region is None:
            return None
        try:
            return region.read(lx, lz)
        except Unsupported:
            raise
        except Exception as e:  # corrupt chunk: report, keep going
            res["read_errors"] += 1
            add_example({"category": "read_error", "chunk": [rx * 32 + lx, rz * 32 + lz], "detail": str(e)})
            return None

    def add_example(ex):
        if len(res["examples"]) < max_examples:
            res["examples"].append(ex)

    positions = set()
    for r in (ra, rb):
        if r:
            positions.update(r.positions())
    for lx, lz in sorted(positions):
        cx, cz = rx * 32 + lx, rz * 32 + lz
        if not _in_area(cx, cz, radius):
            continue
        ca, cb = load(ra, lx, lz), load(rb, lx, lz)
        fa, fb = ca is not None and is_full(ca), cb is not None and is_full(cb)
        if fa != fb:
            side = "full_only_a" if fa else "full_only_b"
            res[side] += 1
            other = cb if fa else ca
            add_example({"category": "status", "chunk": [cx, cz], "detail": "%s; other side: %s" % (
                side, other.get("Status") if other else "missing")})
            continue
        if not fa:
            continue
        res["chunks_compared"] += 1
        findings = compare_chunk(ca, cb, cx, cz)
        if findings:
            res["chunks_mismatched"] += 1
            for cat in {f["category"] for f in findings}:
                res["categories"][cat] = res["categories"].get(cat, 0) + 1
            for f in findings[:2]:
                f["chunk"] = [cx, cz]
                add_example(f)
    return res


def merge(total, part, max_examples):
    for k in ("chunks_compared", "chunks_mismatched", "full_only_a", "full_only_b", "read_errors"):
        total[k] += part[k]
    for cat, n in part["categories"].items():
        total["categories"][cat] = total["categories"].get(cat, 0) + n
    total["examples"].extend(part["examples"])
    total["examples"].sort(key=lambda e: tuple(e.get("chunk", (0, 0))))
    del total["examples"][max_examples:]


def region_overlaps_area(rx, rz, radius):
    if radius is None:
        return True
    lim = radius - 1
    return rx * 32 <= lim and rx * 32 + 31 >= -lim and rz * 32 <= lim and rz * 32 + 31 >= -lim


def compare_dimension(dir_a, dir_b, dim, radius, max_examples, jobs):
    rel = DIMENSIONS[dim]
    pa, pb = os.path.join(dir_a, rel), os.path.join(dir_b, rel)
    names = set()
    for p in (pa, pb):
        if os.path.isdir(p):
            names.update(n for n in os.listdir(p) if REGION_RE.match(n))
    tasks = []
    for n in sorted(names):
        m = REGION_RE.match(n)
        if region_overlaps_area(int(m.group(1)), int(m.group(2)), radius):
            tasks.append((os.path.join(pa, n), os.path.join(pb, n), n, radius, max_examples))
    total = _empty_result()
    total["regions"] = len(tasks)
    if jobs > 1 and len(tasks) > 1:
        with Pool(min(jobs, len(tasks))) as pool:
            for part in pool.imap_unordered(compare_region_pair, tasks):
                merge(total, part, max_examples)
    else:
        for t in tasks:
            merge(total, compare_region_pair(t), max_examples)
    total["ok"] = (total["chunks_compared"] > 0 and total["chunks_mismatched"] == 0
                   and total["full_only_a"] == 0 and total["full_only_b"] == 0
                   and total["read_errors"] == 0)
    if total["chunks_compared"] == 0:
        total["note"] = "no full chunks compared"
    return total


def print_summary(results):
    for dim, r in results.items():
        status = "OK" if r["ok"] else "MISMATCH"
        print("[%s] %s: regions=%d compared=%d mismatched=%d full_only_a=%d full_only_b=%d read_errors=%d" % (
            status, dim, r["regions"], r["chunks_compared"], r["chunks_mismatched"],
            r["full_only_a"], r["full_only_b"], r["read_errors"]))
        if r.get("note"):
            print("  note: " + r["note"])
        for cat, n in sorted(r["categories"].items()):
            print("  %s: %d chunks" % (cat, n))
        for ex in r["examples"]:
            print("  example: " + json.dumps(ex, default=str))


# ----------------------------------------------------------------- self test

def _pack(indices, bits):
    per = 64 // bits
    longs = []
    for start in range(0, len(indices), per):
        v = 0
        for j, idx in enumerate(indices[start:start + per]):
            v |= idx << (j * bits)
        longs.append(v - (1 << 64) if v >= 1 << 63 else v)
    return array("q", longs)


def _container(entries, indices, minbits):
    c = {"palette": entries}
    if len(entries) > 1:
        c["data"] = _pack(indices, max(minbits, (len(entries) - 1).bit_length()))
    return c


def _synthetic_chunk(order, padding, biome_palette, tweak=None):
    """Same 4096 blocks regardless of `order`/`padding`; `tweak` flips one block to dirt."""
    logical = ["minecraft:air"] * SECTION_BLOCKS
    for i in range(0, SECTION_BLOCKS, 3):
        logical[i] = "minecraft:stone"
    logical[17] = "dirt_slab"
    if tweak is not None:
        logical[tweak] = "minecraft:dirt"
    defs = {
        "minecraft:air": {"Name": "minecraft:air"},
        "minecraft:stone": {"Name": "minecraft:stone"},
        "minecraft:dirt": {"Name": "minecraft:dirt"},
        "dirt_slab": {"Name": "minecraft:oak_slab", "Properties": {"waterlogged": "false", "type": "bottom"}},
    }
    palette = [defs[n] for n in order] + [{"Name": "minecraft:filler_%d" % i} for i in range(padding)]
    index = {n: i for i, n in enumerate(order)}
    return {
        "DataVersion": 3839, "Status": "minecraft:full", "xPos": 0, "zPos": 0, "LastUpdate": padding,
        "sections": [{"Y": 0,
                      "block_states": _container(palette, [index[n] for n in logical], 4),
                      "biomes": _container(biome_palette, [0] * SECTION_BIOMES, 0),
                      "SkyLight": bytes(2048)}],
        "block_entities": [], "Heightmaps": {"WORLD_SURFACE": _pack([5] * 256, 9)},
        "structures": {"starts": {}, "References": {"minecraft:village": array("q", [3, 1, 2])}},
    }


def _encode(value):
    def name(s):
        b = s.encode()
        return struct.pack(">H", len(b)) + b

    def tag_of(v):
        if isinstance(v, dict):
            return 10
        if isinstance(v, list):
            return 9
        if isinstance(v, str):
            return 8
        if isinstance(v, bytes):
            return 7
        if isinstance(v, array):
            return 11 if v.typecode == "i" else 12
        return 3

    def payload(v):
        t = tag_of(v)
        if t == 3:
            return struct.pack(">i", v)
        if t == 8:
            return name(v)
        if t == 7:
            return struct.pack(">i", len(v)) + v
        if t in (11, 12):
            c = array(v.typecode, v)
            if _LITTLE:
                c.byteswap()
            return struct.pack(">i", len(v)) + c.tobytes()
        if t == 9:
            if not v:
                return b"\x00" + struct.pack(">i", 0)
            return bytes([tag_of(v[0])]) + struct.pack(">i", len(v)) + b"".join(payload(x) for x in v)
        return b"".join(bytes([tag_of(x)]) + name(k) + payload(x) for k, x in v.items()) + b"\x00"

    return b"\x0a" + name("") + payload(value)


def self_test():
    a = _synthetic_chunk(["minecraft:air", "minecraft:stone", "dirt_slab"], 0, ["minecraft:plains"])
    b = _synthetic_chunk(["dirt_slab", "minecraft:stone", "minecraft:air", "minecraft:dirt"], 30,
                         ["minecraft:plains", "minecraft:desert"])
    assert compare_chunk(a, b, 0, 0) == [], compare_chunk(a, b, 0, 0)

    c = _synthetic_chunk(["minecraft:air", "minecraft:stone", "dirt_slab", "minecraft:dirt"], 0,
                         ["minecraft:plains"], tweak=4094)
    found = compare_chunk(a, c, 2, -1)
    assert [f["category"] for f in found] == ["block_states"], found
    assert found[0]["pos"] == [2 * 16 + 14, 15, -16 + 15], found[0]
    assert found[0]["a"] == "minecraft:air" and found[0]["b"] == "minecraft:dirt", found[0]

    roundtrip = read_nbt(_encode(a))
    assert plain(roundtrip) == plain(a), "NBT roundtrip mismatch"
    assert compare_chunk(roundtrip, b, 0, 0) == []

    d = dict(a, DataVersion=1)
    assert compare_chunk(a, d, 0, 0)[0]["category"] == "data_version"
    print("self-test passed")


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("dir_a", nargs="?")
    ap.add_argument("dir_b", nargs="?")
    ap.add_argument("--dims", default="overworld,nether,end")
    ap.add_argument("--radius", type=int, default=None,
                    help="only compare chunks with |x|,|z| <= radius-1")
    ap.add_argument("--json", dest="json_out")
    ap.add_argument("--max-examples", type=int, default=20)
    ap.add_argument("--jobs", type=int, default=os.cpu_count() or 1)
    ap.add_argument("--self-test", action="store_true")
    args = ap.parse_args()

    if args.self_test:
        self_test()
        return 0
    if not args.dir_a or not args.dir_b:
        ap.error("two server directories are required")
    dims = [d.strip() for d in args.dims.split(",") if d.strip()]
    for d in dims:
        if d not in DIMENSIONS:
            ap.error("unknown dimension %r (expected %s)" % (d, ", ".join(DIMENSIONS)))

    results = {}
    try:
        for dim in dims:
            results[dim] = compare_dimension(args.dir_a, args.dir_b, dim, args.radius,
                                             args.max_examples, args.jobs)
    except Unsupported as e:
        print("error: " + str(e), file=sys.stderr)
        return 2

    print_summary(results)
    if args.json_out:
        with open(args.json_out, "w", encoding="utf-8") as f:
            json.dump({"dirA": args.dir_a, "dirB": args.dir_b, "radius": args.radius,
                       "ok": all(r["ok"] for r in results.values()), "dimensions": results},
                      f, indent=2, default=str)
    return 0 if all(r["ok"] for r in results.values()) else 1


if __name__ == "__main__":
    sys.exit(main())
