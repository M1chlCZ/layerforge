import sharp from "sharp";

export const shapes = {
  stretch: async (source) => sharp(source).resize(4, 4, { fit: "fill" }).png().toBuffer(),
};
