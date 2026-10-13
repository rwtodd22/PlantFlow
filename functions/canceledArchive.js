export function isCanceledJob(job, statuses) {
  const names = new Set(statuses.filter(status => status.code === "CANCELED").map(status => status.name));
  return job.parts?.length ? job.parts.every(part => names.has(part.status)) : names.has(job.status);
}

// Transactional move, followed by resumable history capture. Retries never replace an archive.
export async function archiveCanceledJob(db, jobId, timestamp) {
  const source = db.doc(`jobs/${jobId}`);
  const archive = db.doc(`archivedJobs/${jobId}`);
  await db.runTransaction(async tx => {
    const [jobDoc, archived, configDoc, deletion] = await Promise.all([
      tx.get(source), tx.get(archive), tx.get(db.doc("configuration/plantflow")), tx.get(db.doc(`jobDeletions/${jobId}`)),
    ]);
    if (archived.exists || !jobDoc.exists || deletion.exists || !configDoc.exists) return;
    const job = jobDoc.data(), config = configDoc.data();
    if (!isCanceledJob(job, config.statuses)) return;
    const historyCodes = [...new Set([job.jobNumber, ...(job.parts || []).map(part => part.code)])];
    if (historyCodes.some(code => typeof code !== "string" || !code || code.includes("/") || code === "." || code === "..")) throw new Error("Invalid archive barcode");
    const locks = historyCodes.map(code => db.doc(`archiveHistoryLocks/${code}`));
    const snapshots = await Promise.all(locks.map(lock => tx.get(lock)));
    if (snapshots.some(snapshot => snapshot.exists)) throw new Error("Archive barcode already locked");
    tx.create(archive, {job, departments:config.departments, statuses:config.statuses, archivedAt:timestamp(), archivedBy:"system:canceled", historyStatus:"capturing", historyCodes});
    locks.forEach(lock => tx.create(lock, {archiveId:jobId}));
    tx.delete(source);
    tx.delete(db.doc(`publicJobs/${jobId}`));
  });
  const snapshot = await archive.get();
  if (!snapshot.exists || snapshot.data().archivedBy !== "system:canceled" || snapshot.data().historyStatus !== "capturing") return;
  const record = snapshot.data();
  const queries = [db.collection("scanEvents").where("jobId", "==", jobId)];
  for (let index=0; index<record.historyCodes.length; index+=30) queries.push(db.collection("scanEvents").where("jobNumber", "in", record.historyCodes.slice(index,index+30)));
  for (const query of queries) {
    let cursor;
    while (true) {
      const ordered = query.orderBy("__name__").limit(200);
      const page = await (cursor ? ordered.startAfter(cursor) : ordered).get();
      const batch = db.batch();
      page.docs.forEach(event => { if (!event.data().jobId || event.data().jobId === jobId) batch.set(archive.collection("events").doc(event.id), event.data()); });
      await batch.commit();
      if (page.size < 200) break;
      cursor = page.docs.at(-1);
    }
  }
  const count = await archive.collection("events").count().get();
  await db.runTransaction(async tx => {
    const current = await tx.get(archive);
    if (current.data()?.historyStatus !== "capturing") return;
    tx.update(archive, {historyStatus:"complete", historyEventCount:count.data().count, historyCapturedAt:timestamp()});
    record.historyCodes.forEach(code => tx.delete(db.doc(`archiveHistoryLocks/${code}`)));
  });
}
