/**
 * Local/unpacked builds enable FFmpeg WASM WebM→MP4 transcoding for LinkedIn
 * when Chrome cannot record H.264/AAC natively. Packaged Chrome Web Store
 * builds rewrite this to false and omit extension/ffmpeg/.
 */
const FRAMEIT_FFMPEG_TRANSCODING = true;
