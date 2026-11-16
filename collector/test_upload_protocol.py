import io,json,unittest
from upload_protocol import read_upload,decode_upload,UploadError
class Fragmented:
 def __init__(self,body):self.body=io.BytesIO(body)
 def read(self,n):return self.body.read(min(n,7))
class UploadProtocolTests(unittest.TestCase):
 def test_fragmented_http_body_is_fully_read(self):
  body=b'{"node":"N5","rows":[[1794829058000,5000,5500]]}'
  self.assertEqual(read_upload(Fragmented(body),{'Content-Length':str(len(body))}),body)
 def test_short_connection_is_distinct_from_invalid_json(self):
  body=b'{"node":"N5","rows":[[1794829058000,5000'
  with self.assertRaises(UploadError) as c:read_upload(io.BytesIO(body),{'Content-Length':str(len(body)+12)})
  self.assertEqual(c.exception.kind,'incomplete');self.assertEqual(c.exception.body,body)
  with self.assertRaises(UploadError) as c:decode_upload(body)
  self.assertEqual(c.exception.kind,'json');self.assertIsNotNone(c.exception.position)
 def test_empty_request_is_not_a_heartbeat(self):
  with self.assertRaises(UploadError):read_upload(io.BytesIO(),{'Content-Length':'0'})
  self.assertEqual(decode_upload(b'{"node":"N5","rows":[]}')[2],[])
 def test_all_rows_are_validated_before_any_can_be_saved(self):
  with self.assertRaises(UploadError):decode_upload(json.dumps({'node':'N5','rows':[[1,5000,6000],[2,'bad',6000]]}).encode())
 def test_old_band_layout_remains_supported(self):
  _,node,rows=decode_upload(b'{"node":"N5","rows":[[1,5000,5500]]}')
  self.assertEqual(node,'N5');self.assertEqual(rows[0][2:4],(50,55));self.assertEqual(len(rows[0]),12)
if __name__=='__main__':unittest.main()
