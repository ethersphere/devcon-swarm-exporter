import { fs } from "zx";
import {
  cleanupDirectory,
  downloadMissingCacheFiles,
  downloadMissingChunks,
  fetchNextjsImages,
  updateImageSrcSetValues,
  updateImgSrcValues,
  updateJsFiles,
  downloadNextDataFiles,
  execCommand,
  downloadCssUrls,
  addIndex,
  removeHtmlComments,
  downloadAssets,
  fetchSrcSetImages,
  removePreloadImages,
  fetchNextStaticImages,
  updateNextStaticImages,
  updateAllNextjsImages,
  updateAllSrcSetImages,
  updateAllNextStaticImages,
  updateAllTinaAssets,
  optimizeStaticMediaImages,
  updateAllGoogleStorageAssets,
  fetchTicketAvailability,
  updateTicketsUrl,
} from "./utils";
import { DevconFolder, WebsiteUrls } from "./config";
import { green } from "picocolors";

export const cloneWebsite = async (fresh = false) => {
  if (fresh) {
    fs.rmSync(DevconFolder, { recursive: true, force: true });
  }
  if (!fs.existsSync(DevconFolder)) {
    try {
      fs.mkdirSync(DevconFolder, { recursive: true });
      console.log(
        `Cloning website ${WebsiteUrls.join(" ")} to ${DevconFolder}...`
      );
      const command = "httrack";
      let args = [
        WebsiteUrls[0],
        WebsiteUrls[1],
        WebsiteUrls[2],
        "-O",
        DevconFolder,
        "-N100",
        "-I0",
        "--near",
        "-v"
      ];
      try {
        const exitCode = await execCommand(command, args);
        console.log(`httrack exited with code ${exitCode}`);
      } catch (error) {
        console.error(`Error executing command: ${error}`);
      }
      console.log(
        `Website ${WebsiteUrls.join(
          " "
        )} cloned successfully to ${DevconFolder}.`
      );
    } catch (error) {
      console.error("Error cloning website:", error);
    }
  } else {
    console.log(`${green(DevconFolder)} folder already exixts`);
  }
};

const FN = {
  removePreloadImages,
  cleanupDirectory,
  downloadAssets,
  downloadMissingCacheFiles,
  downloadMissingChunks,
  downloadNextDataFiles,
  downloadCssUrls,
  updateJsFiles,
  updateAllNextjsImages,
  updateAllSrcSetImages,
  updateAllNextStaticImages,
  updateAllGoogleStorageAssets,
  updateAllTinaAssets,
  optimizeStaticMediaImages
}

export const exportStatic = async () => {
  const startTime = Date.now();
  await removePreloadImages();
  await cleanupDirectory();
  await removeHtmlComments();
  await downloadAssets();
  await downloadMissingCacheFiles();
  await downloadMissingChunks();
  await downloadNextDataFiles();
  await downloadCssUrls();
  await updateJsFiles();
  await updateAllNextjsImages();
  await updateAllSrcSetImages();
  await updateAllNextStaticImages();
  await updateAllGoogleStorageAssets();
  await updateAllTinaAssets();
  await optimizeStaticMediaImages();
  await fetchTicketAvailability();
  await updateTicketsUrl();
  addIndex();
  const endTime = Date.now();
  const elapsedTime = endTime - startTime;
  console.log(`Time taken: ${(elapsedTime/60000).toFixed(2)} mins`);
};
