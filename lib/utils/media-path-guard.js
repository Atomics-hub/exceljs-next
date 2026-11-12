'use strict';

const fs = require('fs');
const path = require('path');

// Local image files (adapted from exceljs-hardened, MIT).
// addImage({filename}) reads whatever path it is given, by design. An application that builds that
// path from user input (path.join(baseDir, name)) can be tricked into reading other files; the fix
// for that is safeJoin() below, exported as ExcelJS.utils.safeJoin.
//
// assertSafeMediaPath() is kept permissive on purpose: rejecting ".." broke legitimate relative paths (e.g. '../logo.png')
// while not stopping traversal, because path.join() has already collapsed ".." by the time a path
// reaches addImage(). Applications taking file names from users should resolve them with safeJoin().
function assertSafeMediaPath(filename) {
  if (typeof filename !== 'string' || filename.length === 0) {
    return;
  }
  if (filename.includes('\0')) {
    throw new Error('Invalid media path: contains a null byte.');
  }
}

// [exceljs-hardened] This is the fix that actually matters for the
// classic exploit chain — read it before relying on assertSafeMediaPath
// alone.
//
// The realistic vulnerable pattern is:
//   const resolvedPath = path.join(baseDir, userInput);
//   workbook.addImage({filename: resolvedPath});
//
// path.join() ALREADY resolves and strips ".." segments before that
// string ever reaches addImage() — e.g.
//   path.join('/app/assets/logos', '../../../.env') === '/app/.env'
// By the time assertSafeMediaPath() sees it, there is no ".." left to
// catch, and it (correctly, by its own contract) lets a fully-resolved
// absolute path through. No check performed *after* path.join() can
// undo that: the traversal information is already gone from the string.
//
// safeJoin() fixes this by doing the resolution and the containment
// check together, in the right order: resolve first, then verify the
// result is still inside baseDir. Applications should call this instead
// of path.join() wherever a user-influenced fragment is combined with a
// trusted base directory before being handed to addImage()/addMedia().
// [exceljs-hardened] VULN-14: realpath of `p`, tolerating a path that does not exist (yet): the
// nearest existing ancestor is resolved and the missing tail appended. A dangling symbolic link is
// refused, since its destination cannot be checked.
function realpathLoose(p) {
  if (typeof fs.realpathSync !== 'function') {
    return p;
  }
  const tail = [];
  let current = p;
  for (;;) {
    try {
      return path.join(fs.realpathSync(current), ...tail.reverse());
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') {
        throw error;
      }
      let isLink = false;
      try {
        isLink = fs.lstatSync(current).isSymbolicLink();
      } catch (e) {
        // does not exist at all: climb up
      }
      if (isLink) {
        throw new Error(`Refusing to resolve "${p}": "${current}" is a dangling symbolic link.`);
      }
      const parent = path.dirname(current);
      if (parent === current) {
        return p;
      }
      tail.push(path.basename(current));
      current = parent;
    }
  }
}

function safeJoin(baseDir, userPath) {
  const resolvedBase = path.resolve(baseDir);
  const resolvedTarget = path.resolve(resolvedBase, userPath);
  // Both sides are resolved through symbolic links, so a base that is itself a symlink
  // (/var/www/current -> a release dir) stays valid, while a link inside it pointing outside is refused.
  const relative = path.relative(realpathLoose(resolvedBase), realpathLoose(resolvedTarget));

  const escapesBase = relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
  if (escapesBase) {
    throw new Error(
      `Refusing to resolve "${userPath}" against base directory "${resolvedBase}": ` +
        `it resolves to "${resolvedTarget}", which is outside the base directory.`
    );
  }

  return resolvedTarget;
}

// [exceljs-hardened] VULN-12: `image.extension` ends up unencoded in the zip entry name
// (`xl/media/image0.<ext>`, a zip-slip for naive extractors) and in a .rels `Target`. Real image
// extensions are 1-5 alphanumeric characters (png, jpeg, jpg, gif, webp, tiff, svg, emf...).
// An absent extension is left alone: that historical (sloppy) usage keeps working.
const SAFE_IMAGE_EXTENSION = /^[a-z0-9]{1,5}$/i;

function assertSafeImageExtension(extension) {
  if (extension === undefined || extension === null) {
    return;
  }
  if (typeof extension !== 'string' || !SAFE_IMAGE_EXTENSION.test(extension)) {
    throw new Error(
      `Invalid image extension ${JSON.stringify(extension)}: expected 1 to 5 letters or digits (e.g. "png").`
    );
  }
}

module.exports = {assertSafeMediaPath, assertSafeImageExtension, safeJoin};
