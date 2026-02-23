import fs from "fs-extra";
import path from "path";

const BRAIN_BASE = process.env.BRAIN_PATH || "./brain";

/**
 * Validate that a path component does not escape the intended directory.
 * Rejects path traversal sequences and absolute paths.
 * @param {string} component - Path component to validate (namespace or filename)
 * @param {string} label - Human-readable label for error messages
 */
function validatePathComponent(component, label) {
  if (typeof component !== "string" || component.length === 0) {
    throw new Error(`Invalid ${label}: must be a non-empty string`);
  }
  // Reject absolute paths and directory traversal
  if (path.isAbsolute(component) || component.includes("..")) {
    throw new Error(`Invalid ${label}: path traversal not allowed`);
  }
}

/**
 * Get full path for a brain file, creating directories if needed
 * @param {string} namespace - Agent namespace (e.g., '01_EDMO', '06_CFO')
 * @param {string} filename - File name
 * @returns {Promise<string>} Full path to the file
 */
export async function brainPath(namespace, filename) {
  try {
    validatePathComponent(namespace, "namespace");
    validatePathComponent(filename, "filename");
    const dirPath = path.join(BRAIN_BASE, "brain", namespace);
    await fs.ensureDir(dirPath);
    const fullPath = path.join(dirPath, filename);
    // Final safety check: resolved path must be under the brain directory
    const resolvedBase = path.resolve(BRAIN_BASE, "brain");
    const rel = path.relative(resolvedBase, path.resolve(fullPath));
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      throw new Error("Path escapes brain directory");
    }
    return fullPath;
  } catch (error) {
    await logError("brainPath", { namespace, filename, error: error.message });
    throw error;
  }
}

/**
 * Read and parse JSON from brain storage
 * @param {string} namespace - Agent namespace
 * @param {string} filename - File name
 * @returns {Promise<object>} Parsed JSON or empty object if not found
 */
export async function readBrain(namespace, filename) {
  try {
    const filePath = await brainPath(namespace, filename);
    const exists = await fs.pathExists(filePath);
    if (!exists) {
      return {};
    }
    const content = await fs.readFile(filePath, "utf-8");
    return JSON.parse(content);
  } catch (error) {
    await logError("readBrain", { namespace, filename, error: error.message });
    return {};
  }
}

/**
 * Write JSON data to brain storage atomically
 * @param {string} namespace - Agent namespace
 * @param {string} filename - File name
 * @param {object} data - Data to write
 */
export async function writeBrain(namespace, filename, data) {
  try {
    const filePath = await brainPath(namespace, filename);
    const tempPath = `${filePath}.tmp`;
    await fs.writeFile(tempPath, JSON.stringify(data, null, 2), "utf-8");
    await fs.rename(tempPath, filePath);
  } catch (error) {
    await logError("writeBrain", { namespace, filename, error: error.message });
    throw error;
  }
}

/**
 * Append an entry to a JSON array in brain storage
 * @param {string} namespace - Agent namespace
 * @param {string} filename - File name
 * @param {any} entry - Entry to append
 */
export async function appendBrain(namespace, filename, entry) {
  try {
    const data = await readBrain(namespace, filename);
    const arr = Array.isArray(data) ? data : [];
    arr.push(entry);
    await writeBrain(namespace, filename, arr);
  } catch (error) {
    await logError("appendBrain", {
      namespace,
      filename,
      error: error.message,
    });
    throw error;
  }
}

/**
 * List all files in a brain namespace
 * @param {string} namespace - Agent namespace
 * @returns {Promise<string[]>} Array of filenames
 */
export async function listBrain(namespace) {
  try {
    const dirPath = path.join(BRAIN_BASE, "brain", namespace);
    const exists = await fs.pathExists(dirPath);
    if (!exists) {
      return [];
    }
    const files = await fs.readdir(dirPath);
    return files.filter((f) => !f.startsWith("."));
  } catch (error) {
    await logError("listBrain", { namespace, error: error.message });
    return [];
  }
}

/**
 * Log errors to brain/errors directory
 * @param {string} operation - Operation that failed
 * @param {object} details - Error details
 */
async function logError(operation, details) {
  try {
    const errorsDir = path.join(BRAIN_BASE, "brain", "errors");
    await fs.ensureDir(errorsDir);

    const today = new Date().toISOString().split("T")[0];
    const logFile = path.join(errorsDir, `filesystem_errors_${today}.json`);

    let errors = [];
    const exists = await fs.pathExists(logFile);
    if (exists) {
      const content = await fs.readFile(logFile, "utf-8");
      errors = JSON.parse(content);
    }

    errors.push({
      timestamp: new Date().toISOString(),
      operation,
      ...details,
    });

    await fs.writeFile(logFile, JSON.stringify(errors, null, 2), "utf-8");
  } catch (e) {
    console.error("[filesystem] Failed to log error:", e.message);
  }
}
