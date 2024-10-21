import { $, fs } from "zx";
import { replaceInFileSync } from "replace-in-file";
import { DevconFolder, CacheDir, IndexFile, TicketsIndexFileEn, TicketsIndexFileEs } from "./config";
import { Curl } from "node-libcurl";
import sharp from "sharp";
import { mkdirp } from "fs-extra";
import { spawn } from "child_process";

export async function rewriteJsFiles() {
  try {
    console.log(`grep -r -l 'unoptimized:!1' ${DevconFolder}`);
    const out = (await $`grep -r -l 'unoptimized:!1' ${DevconFolder}`).stdout;
    const files = out.trim().split("\n");
    for (let i in files) {
      let file = files[i];
      await $`sed -i 's/unoptimized:!1/unoptimized:!0/g' ${file}`;
    }
  } catch (error: any) {
    if (error.exitCode === 1 && error.stdout == "" && error.stderr == "") {
      console.error(`No files containing 'unoptimized:!1'`);
    } else {
      console.error(`Error fetching files containing 'unoptimized:!1'`, error);
    }
  }
}

export async function removeImgSrcSet(lines: string[], file: string) {
  for (let j in lines) {
    let line = lines[j];
    const options = {
      files: file,
      from: line,
      to: "",
    };
    try {
      const results = replaceInFileSync(options);
    } catch (error) {
      console.error("Error occurred:", error);
    }
  }
}

export async function rewriteImgSrcSet(lines: string[], file: string) {
  for (let j in lines) {
    let line = lines[j];
    const imgs = line.slice(8, -1).split(',').map(v => v.trim().split(' '))
    for (let img of imgs) {
      const imgSrc = img[0]
      const imgData = decodeURIComponent(img[0].split('?url=')[1]).split('&amp;').map(v => v.split('=').pop())
      const imgFile = `${DevconFolder}${imgData[0]}`
      const q = imgData[2] || '75';
      const w = imgData[1] || '2048';
      const targetSrc = `${imgData[0]?.split('.').slice(0, -1).join('.')}_w-${w}_q-${q}.webp`
      const targetFile = `${DevconFolder}${targetSrc}`
      const options = {
        files: file,
        from: imgSrc,
        to: targetSrc,
      };
      await sharp2webp(imgFile, targetFile, 25, parseInt(w))
      try {
        const results = replaceInFileSync(options);
      } catch (error) {
        console.error("Error occurred:", error);
      }
    }
  }
}

export const sharp2webp = async(imgFile:string,targetFile:string,quality=25,w=0)=>{
  if(fs.existsSync(imgFile) && !fs.existsSync(targetFile)){
    if(w > 0){
      return sharp(imgFile, { failOnError: false })
        .webp({ quality, alphaQuality: 100 })
        .resize(w)
        .toFile(targetFile)
    }else{
      return sharp(imgFile, { failOnError: false })
        .webp({ quality, alphaQuality: 100 })
        .toFile(targetFile)
    }
  }else{
    console.log(`SKIPPING: ${!fs.existsSync(imgFile) ? `${imgFile} does not exist` : ''} | ${fs.existsSync(targetFile) ? `${targetFile} exists` : ''}` )
  }
}

export async function rewriteImgSrc(lines: string[], file: string) {
  for (let j in lines) {
    const url = lines[j].slice(5);
    if (url.includes("next/image")) {
      await fetchAndRewriteImgUrl(url, file);
    }
  }
}

export async function fetchAndRewriteImgUrl(src: string, file: string) {
  if (!src.includes("?url=")) {
    console.log(`SKIPPING "${src}" in "${file}"`);
    return;
  }
  let url = src.split("?url=")[1].replace(/&amp;/g, "&");
  let fUrl = url.split(" ")[0];
  let fetchUrl = `https://devcon.org/_next/image/?url=${fUrl}`;
  let srcData: any = decodeURIComponent(src)
    .split("?url=")[1]
    .split("&amp;")
    .map((v) => {
      return v.replace("=", "-").split(".");
    });

  let ext = srcData[0].pop();
  let decodedSrc = `${srcData[0].join(".")}_${srcData[1]}_${srcData[2]}`;
  let cacheFilename = `${decodedSrc.split("/").pop()}.${ext}`;
  let targetFilename = `${decodedSrc.split("/").pop()}.webp`;

  let targetUrl = `/_next/static/media/${targetFilename}`;

  let cacheFile = `${CacheDir}/${cacheFilename}`.replace("////g", "/");
  let targetFile = `${DevconFolder}${targetUrl}`.replace("////g", "/");

  let from = src.split(" ")[0];

  const options = {
    files: file,
    from: from,
    to: targetUrl,
  };

  let makeOptimizedImage = !fs.existsSync(targetFile);
  let downloadCacheImage = !fs.existsSync(cacheFile);
  if (downloadCacheImage) {
    await downloadFile(fetchUrl, cacheFile);
  } else {
    console.log(`SKIPPING download ${fetchUrl}`);
  }
  if (makeOptimizedImage) {
    await sharp2webp(cacheFile, targetFile);
  } else {
    console.log(`SKIPPING optimized webp conversion ${cacheFile}`);
  }

  try {
    const results = replaceInFileSync(options);
  } catch (error) {
    console.error("Error occurred:", error);
  }
}

export async function downloadFile(fetchUrl: string, saveFile: string, overwrite = false) {
  fetchUrl = fetchUrl.replace(/ /g,'%20');
  await mkdirp(saveFile.split("/").slice(0, -1).join("/"));
  if (fs.existsSync(saveFile) && !overwrite) {
    console.log(`SKIPPING ${saveFile} exists`);
    return;
  }else{
    const cacheFile = `${CacheDir}/${saveFile.split('/').pop()}`;
    if(fs.existsSync(cacheFile)){
      console.log(`COPYING FROM CACHE: ${saveFile}`);
      fs.copyFileSync(cacheFile,saveFile);
      return;
    }
  }
  return new Promise((resolve, reject) => {
    const curl = new Curl();
    const file = fs.createWriteStream(saveFile);

    curl.setOpt("URL", fetchUrl);
    curl.setOpt("FOLLOWLOCATION", true);

    curl.on("data", (data: any, size: any, nmemb: any) => {
      file.write(data);
      return size * nmemb;
    });

    curl.on("end", () => {
      file.end();
      console.log(`Download complete: ${saveFile}`);
      curl.close();
      resolve(true);
    });

    curl.on("error", (error) => {
      file.end();
      curl.close();
      console.error(`Error downloading file: ${error.message}`);
      reject(error);
    });

    curl.perform();
  });
}

export const cleanupDirectory = async () => {
  try {
    await $`rm -rf ${DevconFolder}/_next/image/*.html`;
    await $`rm -rf ${DevconFolder}/hts-cache`;
  } catch (error) {
    console.log(error);
  }
};

export const downloadMissingCacheFiles = async () => {
  let files: string[] = [];
  try {
    console.log(`grep -r -l "_next/static" ${DevconFolder}`);
    const out = (await $`grep -r -l "_next/static" ${DevconFolder}`).stdout;
    files = out.trim().split("\n");

    for (const file of files) {
      const out = (await $`grep -o '"[./]*_next/static[^"]*"' ${file}`).stdout;
      const lines = out.trim().split("\n");
      for (const line of lines) {
        const fetchUrl = `https://devcon.org/_next/static${line
          .split("_next/static")[1]
          .slice(0, -1)}`;
        const saveFile = `${DevconFolder}/_next/static${line
          .split("_next/static")[1]
          .slice(0, -1)}`;
        await downloadFile(fetchUrl, saveFile);
      }
    }
  } catch (error) {
    console.error("Error collecting JS files", error);
  }
};

export const downloadMissingChunks = async () => {
  let files: string[] = [];
  try {
    console.log(`grep -r -l "static/chunks" ${DevconFolder}`);
    const out = (await $`grep -r -l "static/chunks" ${DevconFolder}`).stdout;
    files = out
      .trim()
      .split("\n")
      .filter((v) => v.trim().endsWith(".js"));
    for (let file of files) {
      console.log(`grep -o 'static/chunks' ${file}`);
      const out = (await $`grep -o 'static/chunks[^"]*' ${file}`).stdout;
      const lines = out.trim().split("\n");
      let res: any = {};
      for (let line of lines) {
        if (line == "static/chunks/") {
          const out = (
            await $`grep -o  'static/chunks/"+e+"."+([^}]*}' ${file}`
          ).stdout
            .trim()
            .replace('static/chunks/"+e+"."+(', "");
          const chunkData = eval("(" + out + ")");
          for (let key in chunkData) {
            const name = chunkData[key];
            const filename = `${key}.${name}.js`;
            const cacheFile = `${DevconFolder}/_next/static/chunks/${filename}`;
            const fetchUrl = `https://devcon.org/_next/static/chunks/${filename}`;
            await downloadFile(fetchUrl, cacheFile);
          }
        } else if (line.endsWith(".js")) {
          const cacheFile = `${DevconFolder}/_next/${line}`;
          const fetchUrl = `https://devcon.org/_next/${line}`;

          let shouldDownload = true;
          try {
            shouldDownload = !fs.existsSync(cacheFile);
          } catch (error) {
            console.log(`${cacheFile} threw error`, error);
            process.exit(0);
          }

          if (shouldDownload) {
            await mkdirp(cacheFile.split("/").slice(0, -1).join("/"));
            try {
              await downloadFile(fetchUrl, cacheFile);
            } catch (error) {
              console.log(`${cacheFile} threw error`, error);
              process.exit(0);
            }
          }
          res[line] = shouldDownload;
        }
      }
    }
  } catch (error: any) {
    if (error.exitCode === 1 && error.stdout == "" && error.stderr == "") {
      console.error("No files containing 'static/chunks/'");
    } else {
      console.error("Error fetching files containing 'static/chunks/'", error);
    }
  }
};

export const execCommand = (
  command: string,
  args: string[]
): Promise<number> => {
  return new Promise((resolve, reject) => {
    console.log(command + " " + args.join(" "));
    const spawnedProc = spawn(command + " " + args.join(" "), [], {
      shell: true,
    });

    spawnedProc.stdout.on("data", (data) => {
      process.stdout.write(data);
    });

    spawnedProc.stderr.on("data", (data) => {
      process.stderr.write(data);
    });
  });
};

const buildId = async () => {
  try {
    const file = `${DevconFolder}/en/index.html`;
    console.log(`grep -o '/_next/static/[^/]*/_buildManifest.js' ${file}`);
    const out = (
      await $`grep -o '/_next/static/[^/]*/_buildManifest.js' ${file}`
    ).stdout;
    const buildid = out
      .trim()
      .replace("/_next/static/", "")
      .replace("/_buildManifest.js", "");
    return buildid;
  } catch (error) {
    console.error("Error fetching buildId", error);
  }
};

export const addIndex = () => {
  fs.writeFileSync(`${DevconFolder}/index.html`, IndexFile);
  fs.renameSync(`${DevconFolder}/en/tickets/index.html`, `${DevconFolder}/en/tickets/index.html.orig`);
  fs.writeFileSync(`${DevconFolder}/en/tickets/index.html`, TicketsIndexFileEn);
  fs.renameSync(`${DevconFolder}/es/tickets/index.html`, `${DevconFolder}/es/tickets/index.html.orig`);
  fs.writeFileSync(`${DevconFolder}/es/tickets/index.html`, TicketsIndexFileEs);
};

export const removeHtmlComments = async () => {
  let out = ''
  try {
    console.log(`grep -r -l '<!-- ' ${DevconFolder}`);
    out = (await $`grep -r -l '<!-- ' ${DevconFolder}`).stdout;
  } catch (err) {
    return
  }
  const files = out.trim().split("\n");
  for (let file of files) {
    await $`sed -i 's/<!-- -->/<!--_-->/g' ${file}`;
    await $`sed -i 's/<!-- .*-->//g' ${file}`;
    await $`sed -i 's/<!--_-->/<!-- -->/g' ${file}`;
  }
};



export const removePreloadImages = async () => {
  let out = ''
  try {
    console.log(`grep -r -l '<link rel="preload" as="image"' ${DevconFolder}`);
    out = (await $`grep -r -l '<link rel="preload" as="image"' ${DevconFolder}`).stdout;
  } catch (err) {
    return
  }
  const files = out.trim().split("\n");
  for (let file of files) {
    const out = (await $`grep -o '<link rel="preload" as="image"[^>]*>' ${file}`).stdout;
    const lines = out
        .trim()
        .split("\n");
    for(let line of lines){
      const options = {
        files: file,
        from: line,
        to: "",
      };
      try {
        const results = replaceInFileSync(options);
      } catch (error) {
        console.error("Error occurred:", error);
      }
    }
  }
};

export const downloadAssets = async () => {
  await downloadFile(`https://devcon.org/favicon.ico`, `${DevconFolder}/favicon.ico`)
  const textures = ['mountain','unicorn','panda','rocket']
  for(let texture of textures){
    await downloadFile(`https://devcon.org/assets/textures/${texture}.png`, `${DevconFolder}/assets/textures/${texture}.png`)
  }
  console.log(`grep -r -l "assets/" ${DevconFolder}`);
  const out = (await $`grep -r -l "assets/" ${DevconFolder}`).stdout;
  const files = out.trim().split("\n");
  for (let file of files) {
    console.log(`grep -o 'assets/[^"]*' ${file}`)
    if (!file.endsWith('.js')) {
      const out = (await $`grep -o 'assets/[^"]*' ${file}`).stdout;
      const lines = out
        .trim()
        .split("\n");
      for (let line of lines) {
        const imgs = line.split(',').map(v => v.split(' ')[0])
        for (let img of imgs) {
          if (!fs.existsSync(`${DevconFolder}/${img}`) && !img.includes('_w-')) {
            const fetchUrl = `https://devcon.org/${img}`
            const saveFile = `${DevconFolder}/${img}`
            await downloadFile(fetchUrl, saveFile)
          }
        }
      }
    }
  }
}

export const downloadCssUrls = async () => {
  try {
    console.log(`grep -r -l "url(" ${DevconFolder}`);
    const out = (await $`grep -r -l "url(" ${DevconFolder}`).stdout;
    const files = out.trim().split("\n");
    for (let file of files) {
      const out = (await $`grep -o 'url([^)]*)' ${file}`).stdout;
      const lines = out
        .trim()
        .split("\n")
        .filter((v) => v.startsWith("url(../media/"));
      for (let line of lines) {
        line = line.slice(7, -1);
        const fetchUrl = `https://devcon.org/_next/static/${line}`;
        const saveFile = `${DevconFolder}/_next/static/${line}`;
        await downloadFile(fetchUrl, saveFile);
      }
    }
  } catch (error: any) {
    if (error.exitCode === 1 && error.stdout == "" && error.stderr == "") {
      console.error("No files containing 'next/image'");
    } else {
      console.error("Error fetching files containing 'next/image'", error);
    }
  }
};

export const downloadNextDataFiles = async () => {
  try {
    const buildID = await buildId();
    let DataFiles = ['en', 'es'];
    const files = (await $`ls -d ${DevconFolder}/en/*/`).stdout.trim().split("\n").map(v => v.split('/en/')[1].slice(0, -1))
    for (let file of files) {
      DataFiles.push(`en/${file}`)
      DataFiles.push(`es/${file}`)
    }
    for (const filename of DataFiles) {
      const fetchUrl = `https://devcon.org/_next/data/${buildID}/${filename}.json`;
      const cacheFile = `${DevconFolder}/_next/data/${buildID}/${filename}.json`;
      await downloadFile(fetchUrl, cacheFile);
    }
  } catch (error) {
    console.error("Error collecting _next/data files", error);
  }
};

export const updateJsFiles = async () => {
  try {
    await rewriteJsFiles();
  } catch (error) {
    console.error("Error rewriting JS files", error);
  }
};

export const fetchNextjsImages = async () => {
  try {
    console.log(`grep -r -l "next/image" ${DevconFolder}`);
    const out = (await $`grep -r -l "next/image" ${DevconFolder}`).stdout;
    const files = out.trim().split("\n");
    return files;
  } catch (error: any) {
    if (error.exitCode === 1 && error.stdout == "" && error.stderr == "") {
      console.error("No files containing 'next/image'");
    } else {
      console.error("Error fetching files containing 'next/image'", error);
    }
  }
};

export const fetchNextStaticImages = async () => {
  try {
    console.log(`grep -r -l "_next/static" ${DevconFolder}`);
    const out = (await $`grep -r -l "_next/static" ${DevconFolder}`).stdout;
    const files = out.trim().split("\n").filter(v=>v.trim().endsWith('.js'));
    return files;
  } catch (error: any) {
    if (error.exitCode === 1 && error.stdout == "" && error.stderr == "") {
      console.error("No files containing '_next/static'");
    } else {
      console.error("Error fetching files containing '_next/static'", error);
    }
  }
};

export const fetchSrcSetImages = async () => {
  try {
    console.log(`grep -r -l "srcSet" ${DevconFolder}`);
    const out = (await $`grep -r -l "srcSet" ${DevconFolder}`).stdout;
    const files = out.trim().split("\n");
    return files;
  } catch (error: any) {
    if (error.exitCode === 1 && error.stdout == "" && error.stderr == "") {
      console.error("No files containing 'srcSet'");
    } else {
      console.error("Error fetching files containing 'srcSet'", error);
    }
  }
};

export const updateImageSrcSetValues = async (file: string) => {
  try {
    const out = (await $`grep -o 'srcSet="[^"]*"' ${file}`).stdout;
    const lines = out.trim().split("\n");
    await removeImgSrcSet(lines, file);
  } catch (error: any) {
    if (error.exitCode === 1 && error.stdout == "" && error.stderr == "") {
      console.error(`${file} does not contain 'srcSet="[^"]*"'`);
    } else {
      console.error(`Error looking up 'srcSet="[^"]*"' in ${file}`, error);
    }
  }
};

export const updateImgSrcValues = async (file: string) => {
  try {
    const out = (await $`grep -o 'src="[^"]*' ${file}`).stdout;
    const lines = out.trim().split("\n");
    await rewriteImgSrc(lines, file);
  } catch (error: any) {
    if (error.exitCode === 1 && error.stdout == "" && error.stderr == "") {
      console.error(`${file} does not contain 'src="[^"]*'`);
    } else {
      console.error(`Error looking up 'src="[^"]*' in ${file}`, error);
    }
  }
};

export const updateNextStaticImages = async (file: string) => {
  try {
    const out = (await $`grep -o '/_next/static/media/[^"]*' ${file}`).stdout;
    const lines = out.trim().split("\n").filter(v=> !v.endsWith('.webp'));
    for(let line of lines){
      const imgFile = `${DevconFolder}${line}`
      const targetSrc = line.split('.').slice(0,-1).join('.')+'.webp'
      const targetFile = `${DevconFolder}${targetSrc}`
      await sharp2webp(imgFile,targetFile);
      const options = {
        files: file,
        from: line,
        to: targetSrc,
      };
      try {
        const results = replaceInFileSync(options);
      } catch (error) {
        console.error("Error occurred:", error);
      }
    }
  } catch (error: any) {
    if (error.exitCode === 1 && error.stdout == "" && error.stderr == "") {
      console.error(`${file} does not contain 'src="[^"]*'`);
    } else {
      console.error(`Error looking up 'src="[^"]*' in ${file}`, error);
    }
  }
};


export const updateAllNextjsImages = async () => {
  const files = (await fetchNextjsImages()) || [];
  for (const file of files) {
    await updateImageSrcSetValues(file);
    await updateImgSrcValues(file);
  }
}

export const updateAllSrcSetImages = async () => {
  const files = (await fetchSrcSetImages()) || [];
  for (const file of files) {
    await updateImageSrcSetValues(file);
    await updateImgSrcValues(file);
  }
}

export const updateAllNextStaticImages = async () => {
  const files = (await fetchNextStaticImages()) || [];
  for (const file of files) {
    await updateNextStaticImages(file);
  }
}

export const fetchTinaAssets = async () => {
  try {
    console.log(`grep -r -l "assets.tina.io" ${DevconFolder}`);
    const out = (await $`grep -r -l "assets.tina.io" ${DevconFolder}`).stdout;
    const files = out.trim().split("\n");
    return files;
  } catch (error: any) {
    if (error.exitCode === 1 && error.stdout == "" && error.stderr == "") {
      console.error("No files containing 'assets.tina.io'");
    } else {
      console.error("Error fetching files containing 'assets.tina.io'", error);
    }
  }
  return []
}

export const updateAllTinaAssets = async () => {
  const files = (await fetchTinaAssets()) || [];
  for (const file of files) {
    const out = (await $`grep -o 'https://assets.tina.io[^"]*' ${file}`).stdout;
    const lines = out.trim().split("\n");
    for(let line of lines){
      const fetchUrl = line;
      const imgFile = `${DevconFolder}/_next/static/media/${line.split('/').pop()}`.replace(/ /g,'_');
      await downloadFile(fetchUrl,imgFile)

      const targetFile = imgFile.split('.').slice(0,-1).join('.')+'.webp'
      const targetSrc = targetFile.replace(DevconFolder,'')
      await sharp2webp(imgFile,targetFile);
      const options = {
        files: file,
        from: line,
        to: targetSrc,
      };
      try {
        const results = replaceInFileSync(options);
      } catch (error) {
        console.error("Error occurred:", error);
      }
    }
  }
}

export const fetchGoogleStorageAssets = async () => {
  try {
    console.log(`grep -r -l "storage.googleapis.com" ${DevconFolder}`);
    const out = (await $`grep -r -l "storage.googleapis.com" ${DevconFolder}`).stdout;
    const files = out.trim().split("\n");
    return files;
  } catch (error: any) {
    if (error.exitCode === 1 && error.stdout == "" && error.stderr == "") {
      console.error("No files containing 'storage.googleapis.com'");
    } else {
      console.error("Error fetching files containing 'storage.googleapis.com'", error);
    }
  }
  return []
}

const fetchTicketsUrlFiles = async () => {
  try {
    console.log(`grep -r -l "/tickets" ${DevconFolder}`);
    const out = (await $`grep -r -l "/tickets" ${DevconFolder}`).stdout;
    const files = out.trim().split("\n");
    return files;
  } catch (error: any) {
    if (error.exitCode === 1 && error.stdout == "" && error.stderr == "") {
      console.error("No files containing '/tickets'");
    } else {
      console.error("Error fetching files containing '/tickets'", error);
    }
  }
  return []
}

export const updateTicketsUrl = async () => {
  const files = (await fetchTicketsUrlFiles()) || [];
  for (const file of files) {
    const options = {
      files: file,
      from: `"/tickets"`,
      to: `"https://devcon.org/tickets"`,
    };
    try {
      const results = replaceInFileSync(options);
    } catch (error) {
      console.error("Error occurred:", error);
    }
  }
}

export const updateAllGoogleStorageAssets = async () => {
  const files = (await fetchGoogleStorageAssets()) || [];
  
  for (const file of files) {
    const out = (await $`grep -o 'https://storage.googleapis.com[^"]*' ${file}`).stdout;
    const lines = out.trim().split("\n");
    for(let line of lines){
      const fetchUrl = line;
      const imgFile = `${DevconFolder}/_next/static/media/${line.split('/').pop()}`.replace(/ /g,'_');
      await downloadFile(fetchUrl,imgFile)

      const targetFile = imgFile.split('.').slice(0,-1).join('.')+'.webp'
      const targetSrc = targetFile.replace(DevconFolder,'');
      await sharp2webp(imgFile,targetFile);
      const options = {
        files: file,
        from: line,
        to: targetSrc,
      };
      try {
        const results = replaceInFileSync(options);
      } catch (error) {
        console.error("Error occurred:", error);
      }
    }
  }
}

export const optimizeImageFile = async (file:string, quality=50)=>{
  const ofile = `${DevconFolder}/_next/static/media/${file}`
    const nfile = `${DevconFolder}/_next/static/media/orig.${file}`
    const stats = fs.statSync(ofile);
    const size = Math.round(stats.size / 1000) 
    const targetFile = file.split('.').slice(0,-1).join('.')+'.webp';
    if(size > 200){
      fs.renameSync(ofile,nfile);
      await sharp2webp(nfile,ofile,quality);
    }
}


export const optimizeStaticMediaImages = async ()=>{
  const files = fs.readdirSync(`${DevconFolder}/_next/static/media`);
  for(let file of files){
    await optimizeImageFile(file);
  }
  const mainFiles = files.filter(v=>v.startsWith('left.') || v.startsWith('right.'));
  for(let file of mainFiles){
    await optimizeImageFile(file,50);
  }
  await $`rm -rf ${DevconFolder}/_next/static/media/orig.*`;
}


export const fetchTicketAvailability = async ()=>{
  const url = 'https://devcon.org/api/tickets/availability/';
  downloadFile(url,`${DevconFolder}/api/tickets/availability.json`, true);
  console.log(`grep -r -l "/api/tickets/availability" ${DevconFolder}`);
  const out = (await $`grep -r -l "/api/tickets/availability" ${DevconFolder}`).stdout;
  const files = out.trim().split("\n");
    const file = files[0];
    replaceInFileSync({
      files: file,
      from: '"/api/tickets/availability"',
      to: '"/api/tickets/availability.json"',
    });
}