import {jsPDF} from 'jspdf';
import {autoTable} from 'jspdf-autotable';

// Export only report content, never application navigation or browser print UI.
export async function downloadReport(root:HTMLElement) {
  const pdf=new jsPDF({unit:'pt',format:'letter'});
  const margin=36,width=540,bottom=750;
  let y=margin;
  const clean=(value:string)=>value.replace(/[–—]/g,'-').replace(/\u00a0/g,' ');
  const write=(value:string,size=10,bold=false)=>{
    pdf.setFont('helvetica',bold?'bold':'normal');pdf.setFontSize(size);
    const lines=pdf.splitTextToSize(clean(value.trim()),width) as string[];
    for(const line of lines){if(y+size+5>bottom){pdf.addPage();y=margin;}pdf.text(line,margin,y+size);y+=size+5;}
    y+=5;
  };
  const visit=(element:Element)=>{
    if(element.tagName==='IMG')return;
    if(element.tagName==='TABLE') {
      const table=element as HTMLTableElement;
      const rows=(section:HTMLTableSectionElement)=>Array.from(section.rows).map(row=>Array.from(row.cells).map(cell=>({content:clean(cell.innerText),colSpan:cell.colSpan})));
      autoTable(pdf,{startY:y,margin:{top:36,bottom:42,left:margin,right:margin},head:table.tHead?rows(table.tHead):[],body:Array.from(table.tBodies).flatMap(rows),theme:'striped',styles:{fontSize:9,cellPadding:6,overflow:'linebreak'},headStyles:{fillColor:[21,95,72]},rowPageBreak:'avoid'});
      y=(pdf as jsPDF & {lastAutoTable:{finalY:number}}).lastAutoTable.finalY+16;
      return;
    }
    if(/^H[1-6]$/.test(element.tagName)) {if(y>bottom-65){pdf.addPage();y=margin;}write((element as HTMLElement).innerText,element.tagName==='H1'?20:13,true);return;}
    if(['P','LI','FOOTER'].includes(element.tagName)){write((element as HTMLElement).innerText);return;}
    if(element.matches('.report-metrics,.portal-print-summary')){Array.from(element.children).forEach(child=>write((child as HTMLElement).innerText.replace(/\n/g,' - '),10,true));return;}
    if(!element.children.length){const text=element.textContent?.trim();if(text)write(text);return;}
    Array.from(element.children).forEach(visit);
  };
  const logo=root.querySelector('img');
  if(logo){
    await logo.decode();
    const height=150*logo.naturalHeight/logo.naturalWidth;
    pdf.addImage(logo,'PNG',margin,y,150,height);y+=height+18;
  }
  Array.from(root.children).forEach(visit);
  const count=pdf.getNumberOfPages();
  for(let page=1;page<=count;page++){pdf.setPage(page);pdf.setFontSize(8);pdf.setTextColor(95);pdf.text(`PlantFlow | ${page} / ${count}`,margin,774);}
  const title=root.querySelector('h1')?.textContent||'Production Report';
  pdf.save(`PlantFlow_${title.replace(/[^a-z0-9]+/gi,'_')}_${new Date().toISOString().slice(0,10)}.pdf`);
}
