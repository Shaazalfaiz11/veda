import sharp from 'sharp';

/**
 * The one configured sharp instance. Import this, never 'sharp' directly.
 *
 * libvips is tuned for a machine that has memory to spare, and both of its
 * defaults are wrong for a 512MB container:
 *
 *   - `cache` keeps up to 50MB of decoded operations alive between calls, on
 *     the assumption that the next call will want the same pixels. Nothing
 *     here ever re-reads a page it has already converted, so the cache is
 *     pure resident cost.
 *
 *   - `concurrency` defaults to the number of cores libvips *detects*, which
 *     is the host's count, not the fraction of a core the container is
 *     actually scheduled on. Every one of those threads gets its own working
 *     buffers, so a page decode costs several multiples of the one buffer the
 *     work needs. On a 0.15 CPU allowance the extra threads cannot buy
 *     wall-clock time either — there is no second core to run them on.
 *
 * Neither setting changes a single output pixel; they change how much memory
 * is held to produce them.
 */
sharp.cache(false);
sharp.concurrency(1);

export default sharp;
