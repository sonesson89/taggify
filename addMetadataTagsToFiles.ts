import { promises as fs } from "fs";
import path from "path";
import { exiftool } from "exiftool-vendored";

const folderPath: string = "./testdir";
const outputPath: string = "./outdir";

const removeAllFilesInDirectory = async (
  directoryPath: string,
): Promise<void> => {
  try {
    const files: string[] = await fs.readdir(directoryPath);
    for (const file of files) {
      const filePath: string = path.join(directoryPath, file);
      await fs.unlink(filePath);
    }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    console.error("Error removing files in directory:", errorMessage);
  }
};

const writeTagsToFiles = async (): Promise<void> => {
  try {
    await fs.mkdir(outputPath, { recursive: true });
    const files: string[] = await fs.readdir(folderPath);

    for (const file of files) {
      const sourceFilePath: string = path.join(folderPath, file);
      const targetFilePath: string = path.join(outputPath, file);

      try {
        await fs.copyFile(sourceFilePath, targetFilePath);

        // regex to extract tags from the filename
        // tags are always within brackets like this: [tag1 tag2 tag3]
        // separated by spaces, and can contain any characters except brackets

        const tagsFromName = file.match(/\[([^\[\]]+)\]/)?.[1].split(" ") || [];
        const isGif = path.extname(file).toLowerCase() === ".gif";

        if (isGif) {
          console.log(`Writing metadata tags to GIF file ${file} in Comment field.`);
          // GIF files don't reliably support the same keyword/subject tags, so store the tags in Comment.
          await exiftool.write(
            targetFilePath,
            {
              Comment: tagsFromName.join(", "),
            } as any,
            ["-overwrite_original"],
          );
        } else {
          // Write common keyword/subject fields so tags show up in image metadata viewers.
          await exiftool.write(
            targetFilePath,
            {
              Keywords: tagsFromName,
              Subject: tagsFromName,
            } as any,
            ["-overwrite_original"],
          );
        }

        console.log(`Metadata tags written to ${file}`);
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        console.error(`Error writing metadata to file ${file}:`, errorMessage);
      }
    }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    console.error("Error processing directory:", errorMessage);
  } finally {
    await exiftool.end();
  }
};

const readAllTagsInDirectory = async (directoryPath: string): Promise<void> => {
  let tags: string[] = [];
  try {
    const files: string[] = await fs.readdir(directoryPath);
    for (const file of files) {
      const filePath: string = path.join(directoryPath, file);
      const metadata = await exiftool.read(filePath);
      console.log(`Metadata for ${file}:`, metadata);

      const keywords = metadata.Keywords;
      const comment = metadata.Comment;

      if (keywords) {
        if (Array.isArray(keywords)) {
          tags.push(...keywords);
        } else {
          tags.push(keywords);
        }
      } else if (typeof comment === "string" && comment.length > 0) {
        tags.push(...comment.split(/\s*,\s*/).filter(Boolean));
      }
    }

    tags = tags.filter((tag, index) => tags.indexOf(tag) === index); // Remove duplicates

    console.log("All tags in directory:", tags);
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    console.error("Error reading metadata in directory:", errorMessage);
  }
};

const run = async () => {
  await removeAllFilesInDirectory(outputPath);
  await writeTagsToFiles();

  //readAllTagsInDirectory(outputPath);
};

run();
