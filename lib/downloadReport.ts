import {jsPDF} from 'jspdf';
import {autoTable} from 'jspdf-autotable';

// Export only report content, never application navigation or browser print UI.
export async function downloadReport(root:HTMLElement) {
  const pdf=new jsPDF({unit:'pt',format:'letter'});
  const margin=36,width=540,bottom=750;
  const title=root.querySelector('h1')?.textContent||'Production Report';
  let y=margin;
  const clean=(value:string)=>value.replace(/[–—]/g,'-').replace(/\u00a0/g,' ');
  const write=(value:string,size=10,bold=false)=>{
    pdf.setTextColor(35,55,47);
    pdf.setFont('helvetica',bold?'bold':'normal');pdf.setFontSize(size);
    const lines=pdf.splitTextToSize(clean(value.trim()),width) as string[];
    for(const line of lines){if(y+size+5>bottom){pdf.addPage();y=margin;}pdf.text(line,margin,y+size);y+=size+5;}
    y+=5;
  };
  const visit=(element:Element)=>{
    if(element.tagName==='IMG')return;
    if(element.tagName==='HEADER')return;
    if(element.tagName==='H1')return;
    if(element.tagName==='TABLE') {
      const table=element as HTMLTableElement;
      const rows=(section:HTMLTableSectionElement)=>Array.from(section.rows).map(row=>Array.from(row.cells).map(cell=>({content:clean(cell.innerText),colSpan:cell.colSpan})));
      autoTable(pdf,{startY:y,margin:{top:48,bottom:48,left:margin,right:margin},head:table.tHead?rows(table.tHead):[],body:Array.from(table.tBodies).flatMap(rows),theme:'striped',styles:{font:'helvetica',fontSize:9,cellPadding:8,overflow:'linebreak',textColor:[35,55,47],lineColor:[220,230,224],lineWidth:0.2},headStyles:{fillColor:[21,95,72],textColor:255,fontStyle:'bold'},alternateRowStyles:{fillColor:[244,248,246]},rowPageBreak:'avoid'});
      y=(pdf as jsPDF & {lastAutoTable:{finalY:number}}).lastAutoTable.finalY+16;
      return;
    }
    if(/^H[1-6]$/.test(element.tagName)) {if(y>bottom-65){pdf.addPage();y=margin;}write((element as HTMLElement).innerText,element.tagName==='H1'?20:13,true);return;}
    if(['P','LI','FOOTER'].includes(element.tagName)){write((element as HTMLElement).innerText);return;}
    if(element.matches('.report-metrics,.portal-print-summary')){
      const cards=Array.from(element.children);
      const cardWidth=(width-8*(cards.length-1))/cards.length;
      const content=cards.map(child=>{
        const value=child.querySelector('b')?.textContent||'';
        const label=(child.textContent||'').replace(value,'').trim();
        pdf.setFontSize(12);const values=pdf.splitTextToSize(clean(value),cardWidth-20) as string[];
        pdf.setFontSize(8);const labels=pdf.splitTextToSize(clean(label),cardWidth-20) as string[];
        return {values,labels};
      });
      const height=Math.max(64,...content.map(card=>24+card.values.length*15+card.labels.length*11));
      if(y+height>bottom){pdf.addPage();y=48;}
      content.forEach((card,index)=>{
        const x=margin+index*(cardWidth+8);
        pdf.setFillColor(237,244,240);pdf.roundedRect(x,y,cardWidth,height,5,5,'F');
        pdf.setFont('helvetica','bold');pdf.setFontSize(12);pdf.setTextColor(21,95,72);pdf.text(card.values,x+10,y+20,{lineHeightFactor:1.25});
        pdf.setFont('helvetica','normal');pdf.setFontSize(8);pdf.setTextColor(85,105,95);pdf.text(card.labels,x+10,y+24+card.values.length*15,{lineHeightFactor:1.3});
      });y+=height+20;return;
    }
    if(!element.children.length){const text=element.textContent?.trim();if(text)write(text);return;}
    Array.from(element.children).forEach(visit);
  };
  const logo=root.querySelector('img');
  if(logo){
    await logo.decode();
    const height=140*logo.naturalHeight/logo.naturalWidth;
    pdf.addImage(logo,'PNG',margin,y,140,height);y+=height+22;
  }
  pdf.setDrawColor(21,95,72);pdf.setLineWidth(3);pdf.line(margin,y,margin+width,y);y+=14;
  write(title,22,true);
  write(`Generated ${new Date().toLocaleString()} | PlantFlow`,9);
  y+=12;
  Array.from(root.children).forEach(visit);
  const count=pdf.getNumberOfPages();
  for(let page=1;page<=count;page++){
    pdf.setPage(page);pdf.setFont('helvetica','normal');pdf.setFontSize(8);pdf.setTextColor(95,112,103);
    pdf.setDrawColor(215,226,219);pdf.setLineWidth(.5);pdf.line(margin,760,margin+width,760);
    pdf.text('PlantFlow | Production reporting',margin,776);pdf.text(`Page ${page} of ${count}`,margin+width,776,{align:'right'});
    if(page>1){pdf.text(clean(title),margin,28);pdf.line(margin,34,margin+width,34);}
  }
  pdf.save(`PlantFlow_${title.replace(/[^a-z0-9]+/gi,'_')}_${new Date().toISOString().slice(0,10)}.pdf`);
}
