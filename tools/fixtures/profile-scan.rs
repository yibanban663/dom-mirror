// Investigation kernel only. Mirrors server.js RGB threshold and row early exit.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn scan(a: *const u8, b: *const u8, out: *mut u8, w: usize, h: usize) -> usize {
    let mut changed = 0;
    for y in 0..h {
        unsafe { *out.add(y) = 0; }
        for x in 0..w {
            let p = (y * w + x) * 4;
            unsafe {
                if (a.add(p) as *const u32).read_unaligned() == (b.add(p) as *const u32).read_unaligned() { continue; }
                if (0..3).any(|c| (*a.add(p + c)).abs_diff(*b.add(p + c)) > 2) {
                    *out.add(y) = 1;
                    changed += 1;
                    break;
                }
            }
        }
    }
    changed
}

#[cfg(target_arch = "wasm32")]
#[unsafe(no_mangle)]
pub extern "C" fn alloc(size: usize) -> *mut u8 {
    let mut buffer = Vec::<u8>::with_capacity(size);
    let pointer = buffer.as_mut_ptr();
    std::mem::forget(buffer);
    pointer
}

#[cfg(not(target_arch = "wasm32"))]
fn main() {
    use std::{fs, hint::black_box, time::Instant};
    let args: Vec<_> = std::env::args().collect();
    let w: usize = args[1].parse().unwrap();
    let h: usize = args[2].parse().unwrap();
    let a = fs::read(&args[3]).unwrap();
    let b = fs::read(&args[4]).unwrap();
    assert_eq!(a.len(), w * h * 4);
    assert_eq!(b.len(), a.len());
    let mut out = vec![0; h];
    let mut values = Vec::new();
    let mut checksum = 0;
    for i in 0..60 {
        let start = Instant::now();
        checksum = unsafe { scan(black_box(a.as_ptr()), black_box(b.as_ptr()), black_box(out.as_mut_ptr()), w, h) };
        black_box(&out);
        if i >= 10 { values.push(start.elapsed().as_secs_f64() * 1000.0); }
    }
    values.sort_by(|a, b| a.partial_cmp(b).unwrap());
    println!("{{\"count\":50,\"p50Ms\":{},\"p95Ms\":{},\"changedRows\":{}}}", values[24], values[47], checksum);
}
