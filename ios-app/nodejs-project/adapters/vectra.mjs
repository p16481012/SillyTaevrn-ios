import fs from 'node:fs/promises';
import path from 'node:path';
import writeFileAtomic from 'write-file-atomic';
import { LocalIndex as VectraLocalIndex } from 'vectra/lib/LocalIndex.js';

// Bundle LocalIndex alone, avoiding unused DocumentIndex tokenizers.
// The private fields below are ordinary JS fields in pinned vectra 0.2.2.
export class LocalIndex extends VectraLocalIndex {
    async createIndex(config = { version: 1 }) {
        if (await this.isIndexCreated()) {
            if (!config.deleteIfExists) throw new Error('Index already exists');
            await this.deleteIndex();
        }
        await fs.mkdir(this.folderPath, { recursive: true });
        const data = { version: config.version, metadata_config: config.metadata_config ?? {}, items: [] };
        await writeFileAtomic(path.join(this.folderPath, 'index.json'), JSON.stringify(data));
        this._data = data;
    }
    async endUpdate() {
        if (!this._update) throw new Error('No update in progress');
        await writeFileAtomic(path.join(this.folderPath, 'index.json'), JSON.stringify(this._update));
        this._data = this._update;
        this._update = undefined;
    }
}
export default { LocalIndex };
