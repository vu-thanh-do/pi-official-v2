const xlsx = require('xlsx');
const path = require('path');
const fs = require('fs');

/**
 * Dịch vụ đọc dữ liệu từ file Excel với nhiều sheet và nhiều cột
 * @param {string} filePath - Đường dẫn tới file Excel (tương đối hoặc tuyệt đối)
 * @returns {Object} - Dữ liệu được tổ chức theo cấu trúc sheet -> cột -> dữ liệu
 */
class ExcelReaderService {
  constructor(filePath) {
    this.filePath = filePath;
  }

  /**
   * Kiểm tra sự tồn tại của file
   * @private
   * @returns {boolean} - true nếu file tồn tại, false nếu không
   */
  _validateFile() {
    if (!this.filePath) {
      console.error('Đường dẫn file không được cung cấp!');
      return false;
    }
    
    const absolutePath = path.isAbsolute(this.filePath) 
      ? this.filePath 
      : path.join(__dirname, this.filePath);

    if (!fs.existsSync(absolutePath)) {
      console.error(`File không tồn tại tại đường dẫn: ${absolutePath}`);
      return false;
    }
    
    this.absolutePath = absolutePath;
    return true;
  }

  /**
   * Đọc tất cả dữ liệu từ file Excel
   * @returns {Object} - Dữ liệu từ tất cả các sheet
   */
  readAllSheets() {
    if (!this._validateFile()) {
      return {};
    }

    try {
      const workbook = xlsx.readFile(this.absolutePath, { cellDates: true });
      const sheets = workbook.SheetNames;
      let allData = {};

      sheets.forEach(sheetName => {
        const sheetData = this.readSheet(workbook, sheetName);
        allData[sheetName] = sheetData;
      });

      return allData;
    } catch (error) {
      console.error('Lỗi khi đọc file Excel:', error);
      return {};
    }
  }

  /**
   * Đọc dữ liệu từ một sheet cụ thể
   * @param {Object} workbook - Workbook Excel
   * @param {string} sheetName - Tên sheet cần đọc
   * @returns {Object} - Dữ liệu từ sheet được chỉ định
   */
  readSheet(workbook, sheetName) {
    const sheet = workbook.Sheets[sheetName];

    if (!sheet) {
      console.warn(`Sheet "${sheetName}" không tồn tại!`);
      return {};
    }

    // Chuyển đổi sheet thành mảng các đối tượng (giữ tiêu đề cột)
    const rawData = xlsx.utils.sheet_to_json(sheet, { 
      header: 1,
      defval: null,  // Giá trị mặc định cho ô trống
      blankrows: false  // Bỏ qua các hàng trống
    });

    // Kiểm tra nếu sheet có dữ liệu
    if (rawData.length === 0) {
      console.warn(`Sheet "${sheetName}" không có dữ liệu!`);
      return {};
    }

    // Lấy tiêu đề cột (hàng đầu tiên)
    const headers = rawData[0];
    
    // Kiểm tra nếu không có tiêu đề
    if (!headers || headers.length === 0) {
      console.warn(`Sheet "${sheetName}" không có tiêu đề cột!`);
      return {};
    }

    // Tạo cấu trúc dữ liệu theo từng cột
    let columnData = {};
    
    // Xử lý tiêu đề trùng lặp hoặc không hợp lệ
    const processedHeaders = new Map();
    
    headers.forEach((header, colIndex) => {
      if (header === null || header === undefined) {
        return; // Bỏ qua các cột không có tiêu đề
      }
      
      // Chuyển đổi header thành chuỗi
      const headerStr = String(header).trim();
      if (headerStr === '') {
        return; // Bỏ qua các cột có tiêu đề trống
      }
      
      // Xử lý trường hợp tiêu đề trùng lặp
      let uniqueHeader = headerStr;
      if (processedHeaders.has(headerStr)) {
        const count = processedHeaders.get(headerStr) + 1;
        processedHeaders.set(headerStr, count);
        uniqueHeader = `${headerStr}_${count}`;
      } else {
        processedHeaders.set(headerStr, 1);
      }
      
      // Trích xuất dữ liệu từ cột
      const colData = rawData.slice(1).map(row => {
        // Kiểm tra xem có dữ liệu tại vị trí này không
        return colIndex < row.length ? row[colIndex] : null;
      });
      
      columnData[uniqueHeader] = colData;
    });

    return columnData;
  }

  /**
   * Đọc dữ liệu từ một sheet và cột cụ thể
   * @param {string} sheetName - Tên sheet
   * @param {string} columnName - Tên cột
   * @returns {Array} - Dữ liệu từ cột được chỉ định
   */
  readColumn(sheetName, columnName) {
    const data = this.readAllSheets();
    
    if (!data[sheetName]) {
      console.warn(`Sheet "${sheetName}" không tồn tại hoặc không có dữ liệu!`);
      return [];
    }
    
    if (!data[sheetName][columnName]) {
      console.warn(`Cột "${columnName}" không tồn tại trong sheet "${sheetName}"!`);
      return [];
    }
    
    return data[sheetName][columnName];
  }
}

module.exports = ExcelReaderService;