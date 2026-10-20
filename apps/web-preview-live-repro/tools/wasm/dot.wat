;; v0.3.9 — int8 reference × float32 query dot products (WebAssembly SIMD).
;; scores(q, v, n, dims, out): q = dims f32 at byte offset q; v = n×dims int8 at v; out = n f32 (sum q·v / 127).
;; dims must be a multiple of 16.
(module
  (memory (export "mem") 1)
  (func (export "scores") (param $q i32) (param $v i32) (param $n i32) (param $dims i32) (param $out i32)
    (local $i i32) (local $j i32) (local $p i32) (local $qp i32) (local $acc v128) (local $x v128) (local $lo v128) (local $hi v128)
    (local.set $p (local.get $v))
    (block $done
      (loop $rows
        (br_if $done (i32.ge_u (local.get $i) (local.get $n)))
        (local.set $acc (v128.const f32x4 0 0 0 0))
        (local.set $j (i32.const 0))
        (local.set $qp (local.get $q))
        (block $rowdone
          (loop $cols
            (br_if $rowdone (i32.ge_u (local.get $j) (local.get $dims)))
            (local.set $x (v128.load (local.get $p)))
            (local.set $lo (i16x8.extend_low_i8x16_s (local.get $x)))
            (local.set $hi (i16x8.extend_high_i8x16_s (local.get $x)))
            (local.set $acc (f32x4.add (local.get $acc) (f32x4.mul (f32x4.convert_i32x4_s (i32x4.extend_low_i16x8_s (local.get $lo))) (v128.load (local.get $qp)))))
            (local.set $acc (f32x4.add (local.get $acc) (f32x4.mul (f32x4.convert_i32x4_s (i32x4.extend_high_i16x8_s (local.get $lo))) (v128.load offset=16 (local.get $qp)))))
            (local.set $acc (f32x4.add (local.get $acc) (f32x4.mul (f32x4.convert_i32x4_s (i32x4.extend_low_i16x8_s (local.get $hi))) (v128.load offset=32 (local.get $qp)))))
            (local.set $acc (f32x4.add (local.get $acc) (f32x4.mul (f32x4.convert_i32x4_s (i32x4.extend_high_i16x8_s (local.get $hi))) (v128.load offset=48 (local.get $qp)))))
            (local.set $p (i32.add (local.get $p) (i32.const 16)))
            (local.set $qp (i32.add (local.get $qp) (i32.const 64)))
            (local.set $j (i32.add (local.get $j) (i32.const 16)))
            (br $cols)))
        (f32.store (i32.add (local.get $out) (i32.shl (local.get $i) (i32.const 2)))
          (f32.div
            (f32.add (f32.add (f32x4.extract_lane 0 (local.get $acc)) (f32x4.extract_lane 1 (local.get $acc)))
                     (f32.add (f32x4.extract_lane 2 (local.get $acc)) (f32x4.extract_lane 3 (local.get $acc))))
            (f32.const 127)))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $rows)))))
