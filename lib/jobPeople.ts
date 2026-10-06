import type { Job } from "./dataService";
export type PeopleNames = { customerRepresentatives: string[]; projectManagers: string[] };
export const emptyPeopleNames:PeopleNames={customerRepresentatives:[],projectManagers:[]};
export function cleanPersonName(value:unknown){return String(value||"").trim().replace(/\s+/g," ").slice(0,120);}
export function uniquePersonNames(values:string[]){const names=new Map<string,string>();for(const value of values){const name=cleanPersonName(value);if(name&&!names.has(name.toLocaleLowerCase()))names.set(name.toLocaleLowerCase(),name);}return [...names.values()].sort((a,b)=>a.localeCompare(b));}
export function jobPeopleNames(jobs:Job[],saved:PeopleNames=emptyPeopleNames):PeopleNames{return {customerRepresentatives:uniquePersonNames([...(saved.customerRepresentatives||[]),...jobs.flatMap(job=>[...(job.savedCustomerRepresentatives||[]),job.customerRepresentative||""])]),projectManagers:uniquePersonNames([...(saved.projectManagers||[]),...jobs.flatMap(job=>[...(job.savedProjectManagers||[]),job.projectManager||""])])};}
export function peopleFromForm(form:FormData){return {customerRepresentative:cleanPersonName(form.get("customerRepresentative")),projectManager:cleanPersonName(form.get("projectManager"))};}

export function rememberJobPeople(job:Job,previous?:Job):Job {const names=jobPeopleNames(previous?[previous,job]:[job]);return {...job,savedCustomerRepresentatives:names.customerRepresentatives,savedProjectManagers:names.projectManagers};}
