import * as terser from 'terser'
import fs from 'node:fs'
import path from 'node:path'
import color from 'cli-color'
let srcDir = './dist';
let outDir = './build';
function ensureDirSync(dir) {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
}
let tag = `${color.whiteBright('[') + color.cyanBright('Compiler') + color.whiteBright(']')} - `
let settings = {
    module: true,
    compress: true,
    mangle: true,
    parse: {},
    rename: true
}
function processDir(src, dest) {
    ensureDirSync(dest);
    for (let entry of fs.readdirSync(src, { withFileTypes: true })) {
        let srcPath = path.join(src, entry.name);
        let destPath = path.join(dest, entry.name);
        if (entry.isDirectory()) {
            processDir(srcPath, destPath);
        } else if (entry.isFile() && entry.name.endsWith('.js')) {
            let code = fs.readFileSync(srcPath, 'utf-8');
            terser.minify({ [entry.name]: code }, settings).then(res => {
                if (!res.code)
                    return
                fs.writeFile(destPath, res.code, 'utf-8', err => {
                    if (err)
                        throw err
                    console.log(tag + `${color.greenBright(srcPath.replaceAll('\\', '/'))} ${color.white('->')} ${color.greenBright(destPath.replaceAll('\\', '/'))} ${color.white('|')} ${color.cyanBright('Minified!')}`);
                });
            });
        } else {
            fs.copyFile(srcPath, destPath, err => {
                if (err)
                    throw err
            });
        }
    }
}

// Run
fs.rmSync(outDir, { recursive: true, force: true })
processDir(srcDir, outDir);