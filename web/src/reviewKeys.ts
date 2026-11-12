/** Cache prefix of a Project's GitHub review threads, keyed further by pull request. */
export const reviewThreadsPrefix = (projectId: number) => `p${projectId}:review-threads:`;
