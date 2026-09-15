
export const SEARCH_WORKER_CODE = `
    let vectorIndex = [];

    self.postMessage({ type: 'READY' });

    self.onmessage = function(e) {
        const { type, data } = e.data;
        
        if (type === 'SET_INDEX') {
            // data is an array of { path, vector: Float32Array, ... }
            vectorIndex = data;
            self.postMessage({ type: 'INDEX_UPDATED', size: Array.isArray(vectorIndex) ? vectorIndex.length : 0 });
        } else if (type === 'SEARCH') {
            const { queryVector, k } = data;
            if (!vectorIndex || vectorIndex.length === 0) {
                self.postMessage({ type: 'SEARCH_RESULTS', data: [] });
                return;
            }

            const results = [];
            const qVec = new Float32Array(queryVector);
            
            for (let i = 0; i < vectorIndex.length; i++) {
                const item = vectorIndex[i];
                const similarity = cosineSimilarity(qVec, item.vector);
                results.push({
                    path: item.path,
                    similarity,
                    startOffset: item.startOffset,
                    endOffset: item.endOffset,
                    links: item.links,
                    frontmatter: item.frontmatter
                });
            }

            results.sort((a, b) => b.similarity - a.similarity);
            self.postMessage({ type: 'SEARCH_RESULTS', data: results.slice(0, k) });
        }
    };

    function cosineSimilarity(vecA, vecB) {
        let dotProduct = 0;
        let normA = 0;
        let normB = 0;
        for (let i = 0; i < vecA.length; i++) {
            dotProduct += vecA[i] * vecB[i];
            normA += vecA[i] * vecA[i];
            normB += vecB[i] * vecB[i];
        }
        if (normA === 0 || normB === 0) return 0;
        return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
    }
`;
