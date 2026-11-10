// Which build this is (#497), for the [来源] section of error reports. A copy loaded from the repository says
// `dev`; desktop/scripts/pack-plugin.js replaces this file in every release zip with the first 8 hex digits of
// the commit it packs. Keep it to this one line: the packer writes the whole file.
export const BUILD = "dev";
